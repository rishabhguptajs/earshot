import { spawn } from 'node:child_process';

export interface ExecResult {
  stdout: string;
  stderr: string;
  code: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
}

export interface ExecOptions {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Output beyond this is truncated; a runaway command must not eat the window. */
  maxBytes?: number;
  /** Written to the child's stdin and closed. Absent means stdin is /dev/null. */
  stdin?: string;
}

/**
 * How long a killed child gets before `exec` stops waiting for it.
 *
 * A timeout that does not bound how long the call takes is not a timeout. A
 * child that spawned its own children leaves them holding the pipes open, so
 * `close` never fires however dead the child itself is - which turns a hook with
 * a 10 second timeout into a turn that waits for whatever it started.
 */
export const KILL_GRACE_MS = 2_000;

export const DEFAULT_MAX_OUTPUT_BYTES = 60_000;

/**
 * Runs a command without a shell. Callers that need shell semantics pass the
 * shell explicitly (see `bash.ts`), which keeps the one place that interprets
 * user-visible command strings small enough to reason about.
 */
export function exec(file: string, args: string[], options: ExecOptions): Promise<ExecResult> {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, {
      cwd: options.cwd,
      ...(options.env ? { env: options.env } : {}),
      stdio: [options.stdin === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
      // Its own process group on POSIX, so `kill` can reach what it started.
      // Windows has no groups; `signalTree` uses taskkill /T there instead.
      detached: process.platform !== 'win32',
    });

    if (options.stdin !== undefined) {
      // A child that never reads stdin makes this write fail with EPIPE, which
      // is its choice to make and not an error worth failing the call over.
      child.stdin?.on('error', () => {});
      child.stdin?.end(options.stdin);
    }

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;

    const collect = (into: 'out' | 'err') => (chunk: Buffer) => {
      const current = into === 'out' ? stdout : stderr;
      if (current.length >= maxBytes) return;
      const next = current + chunk.toString('utf8');
      if (into === 'out') stdout = next.slice(0, maxBytes);
      else stderr = next.slice(0, maxBytes);
    };
    child.stdout?.on('data', collect('out'));
    child.stderr?.on('data', collect('err'));

    // SIGTERM first so the child can clean up; SIGKILL only if it ignores that.
    // The whole process group, not just the child: a shell command that started
    // something else leaves that something else running, and holding our pipes.
    const kill = () => {
      signalTree(child, 'SIGTERM');
      setTimeout(() => signalTree(child, 'SIGKILL'), 1000).unref();
      // And a deadline on waiting, because a grandchild we could not reach can
      // keep the pipes open indefinitely and there is nothing more to wait for.
      setTimeout(() => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve({ stdout, stderr, code: null, signal: 'SIGKILL', timedOut });
      }, KILL_GRACE_MS).unref();
    };

    const timer = options.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          kill();
        }, options.timeoutMs)
      : undefined;
    timer?.unref();

    const onAbort = () => kill();
    options.signal?.addEventListener('abort', onAbort, { once: true });

    const cleanup = () => {
      if (timer) clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
    };

    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    });
    child.on('close', (code, signal) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve({ stdout, stderr, code, signal, timedOut });
    });
  });
}

/** Whether an executable is runnable, cached for the life of the process. */
const probes = new Map<string, Promise<boolean>>();

export function hasExecutable(file: string, cwd = process.cwd()): Promise<boolean> {
  const cached = probes.get(file);
  if (cached) return cached;
  const probe = exec(file, ['--version'], { cwd, timeoutMs: 3000 })
    .then((result) => result.code === 0)
    .catch(() => false);
  probes.set(file, probe);
  return probe;
}

/**
 * Kills a child and anything it started.
 *
 * POSIX: the negative pid signals the process group, which the child leads
 * because it was spawned detached. Windows has no process groups, so this is
 * `taskkill /T`, which walks the tree the same way.
 */
function signalTree(child: ReturnType<typeof spawn>, signal: 'SIGTERM' | 'SIGKILL'): void {
  const pid = child.pid;
  if (pid === undefined) return;
  if (process.platform === 'win32') {
    // /F only on the second pass: the first is the child's chance to exit
    // cleanly, and taskkill without /F asks rather than terminates.
    const args = ['/PID', String(pid), '/T', ...(signal === 'SIGKILL' ? ['/F'] : [])];
    try {
      spawn('taskkill', args, { stdio: 'ignore' }).on('error', () => {});
    } catch {
      child.kill(signal);
    }
    return;
  }
  try {
    process.kill(-pid, signal);
  } catch {
    // The group is already gone, or we never led one; the child alone will do.
    try {
      child.kill(signal);
    } catch {
      // Already reaped.
    }
  }
}
