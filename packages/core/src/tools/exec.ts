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
}

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
      stdio: ['ignore', 'pipe', 'pipe'],
    });

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
    const kill = () => {
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 2000).unref();
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
