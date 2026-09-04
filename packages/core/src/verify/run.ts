import { exec } from '../tools/exec.ts';
import { resolveShell } from '../tools/shell.ts';

export interface VerificationResult {
  command: string;
  source: string;
  exitCode: number | null;
  /** Combined output, verbatim. Never summarised - that is the whole point. */
  output: string;
  timedOut: boolean;
}

/**
 * Runs the project's own test command and returns exactly what it printed.
 *
 * The output is reported rather than characterised. "Tests pass" from an agent
 * that did not run them is the single most expensive thing this harness can say,
 * and a summary of the output is where that claim hides.
 */
export async function runVerification(
  command: string,
  source: string,
  options: { cwd: string; env?: NodeJS.ProcessEnv; signal?: AbortSignal; timeoutMs?: number },
): Promise<VerificationResult> {
  // resolveShell throws on Windows without Git Bash. That is a reportable
  // outcome here, not a crash: the turn still happened, and the agent has to say
  // the change is unverified rather than dying at the end of it.
  const result = await (async () => {
    const shell = resolveShell(options.env ?? process.env);
    return exec(shell.file, [...shell.args, command], {
      cwd: options.cwd,
      ...(options.env ? { env: options.env } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
      timeoutMs: options.timeoutMs ?? 300_000,
    });
  })().catch((error: Error) => ({
    stdout: '',
    stderr: `could not run ${command}: ${error.message}`,
    code: null,
    signal: null,
    timedOut: false,
  }));

  return {
    command,
    source,
    exitCode: result.code,
    output: [result.stdout, result.stderr]
      .filter((part) => part.trim() !== '')
      .join('\n')
      .trim(),
    timedOut: result.timedOut,
  };
}
