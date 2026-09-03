import { isAbsolute, relative, resolve, sep } from 'node:path';

/** Resolves a tool-supplied path against the session cwd. */
export function resolvePath(cwd: string, path: string): string {
  return isAbsolute(path) ? resolve(path) : resolve(cwd, path);
}

/**
 * Whether `path` is inside `cwd`. Writes outside the working directory always
 * prompt regardless of configured rules, so this decides when the gate escalates.
 * Compared case-sensitively even on Windows: over-prompting is the safe error.
 */
export function isInside(cwd: string, path: string): boolean {
  const rel = relative(resolve(cwd), resolve(path));
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
}

/** `src/main.ts` when inside cwd, an absolute path when outside. */
export function displayPath(cwd: string, path: string): string {
  const abs = resolve(path);
  return isInside(cwd, abs) ? relative(resolve(cwd), abs).split(sep).join('/') : abs;
}
