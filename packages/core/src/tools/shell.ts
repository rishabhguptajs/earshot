import { existsSync } from 'node:fs';
import { platform } from 'node:os';
import { join } from 'node:path';

/**
 * Where the `bash` tool's shell comes from.
 *
 * On Windows this is Git Bash, and only Git Bash. The alternative considered was
 * falling back to PowerShell when Git Bash is absent, which would have meant the
 * agent's most-used tool speaks two different dialects depending on the machine:
 * quoting, pipelines, `&&`, `$(...)` and path separators all differ, permission
 * rules like `Bash(git *)` would match different strings, and every command the
 * model writes would need translating. One dialect everywhere is worth an install
 * step on the platform where `git` already ships the shell in question.
 */
export interface ShellSpec {
  /** Absolute path or bare name of the shell executable. */
  file: string;
  /** Arguments that precede the command string. */
  args: string[];
}

export class ShellNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ShellNotFoundError';
  }
}

/** Standard install locations for Git for Windows, in preference order. */
function windowsCandidates(env: NodeJS.ProcessEnv): string[] {
  const roots = [
    env.ProgramFiles,
    env['ProgramFiles(x86)'],
    env.LOCALAPPDATA ? join(env.LOCALAPPDATA, 'Programs') : undefined,
  ].filter((root): root is string => typeof root === 'string' && root !== '');

  const fromGitRoots = roots.flatMap((root) => [
    join(root, 'Git', 'bin', 'bash.exe'),
    join(root, 'Git', 'usr', 'bin', 'bash.exe'),
  ]);
  // An explicit override wins: some people install Git somewhere else entirely.
  return [...(env.EARSHOT_BASH ? [env.EARSHOT_BASH] : []), ...fromGitRoots];
}

const WINDOWS_HELP =
  'earshot needs Git Bash to run shell commands on Windows. Install Git for Windows ' +
  '(https://git-scm.com/download/win), or set EARSHOT_BASH to the full path of a ' +
  'bash.exe. PowerShell is not used: one shell dialect on every platform is what ' +
  'keeps commands and permission rules portable.';

/**
 * Resolves the shell once per session. Throws rather than degrading, because a
 * silent fallback to a different shell is exactly the failure this design avoids.
 *
 * `hostPlatform` is a parameter rather than a direct `platform()` read so that a
 * caller which was itself given a platform can pass the same one down. Reading
 * the real platform here made platform-injecting tests exercise whichever branch
 * the CI runner happened to be, not the branch they named: `/doctor`'s Linux test
 * took the Git Bash path on the Windows runner and reported a failing shell check.
 * It narrows nothing - Windows still means Git Bash or an error, never PowerShell.
 */
export function resolveShell(
  env: NodeJS.ProcessEnv = process.env,
  hostPlatform: NodeJS.Platform = platform(),
): ShellSpec {
  if (hostPlatform !== 'win32') {
    // Not `-lc`: a login shell re-runs the user's profile on every call, which is
    // slow and lets a profile's `cd` silently move the command's working directory.
    return { file: env.EARSHOT_BASH ?? '/bin/bash', args: ['-c'] };
  }

  for (const candidate of windowsCandidates(env)) {
    if (existsSync(candidate)) return { file: candidate, args: ['-c'] };
  }
  throw new ShellNotFoundError(WINDOWS_HELP);
}
