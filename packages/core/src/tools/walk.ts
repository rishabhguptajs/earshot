import { readdir, readFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { globToRegExp } from './glob-match.ts';

/** Never worth walking, and walking them is how a glob call takes 40 seconds. */
const ALWAYS_SKIP = new Set([
  '.git',
  'node_modules',
  '.next',
  '.turbo',
  'dist',
  'build',
  'target',
  'vendor',
  '__pycache__',
  '.venv',
  '.mypy_cache',
  '.pytest_cache',
]);

export interface WalkOptions {
  /** Absolute root to walk. */
  root: string;
  /** Stops the walk once this many files have been yielded. */
  limit?: number;
  signal?: AbortSignal;
  /** Additional ignore matcher, e.g. the compiled .gitignore. */
  ignore?: (relativePath: string, isDir: boolean) => boolean;
}

export interface WalkEntry {
  /** Absolute path. */
  path: string;
  /** Path relative to the root, always `/`-separated. */
  rel: string;
  mtimeMs: number;
}

/** Breadth-first so a `limit` cut keeps shallow, more relevant files. */
export async function* walk(options: WalkOptions): AsyncGenerator<WalkEntry> {
  const { root, ignore, signal } = options;
  const limit = options.limit ?? Number.POSITIVE_INFINITY;
  let yielded = 0;
  const queue: string[] = [root];

  while (queue.length > 0 && yielded < limit) {
    const dir = queue.shift() as string;
    signal?.throwIfAborted();
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const abs = join(dir, entry.name);
      const rel = relative(root, abs).split(sep).join('/');
      if (ALWAYS_SKIP.has(entry.name)) continue;
      if (ignore?.(rel, entry.isDirectory())) continue;
      if (entry.isDirectory()) {
        queue.push(abs);
      } else if (entry.isFile()) {
        if (yielded >= limit) return;
        yielded++;
        yield { path: abs, rel, mtimeMs: 0 };
      }
    }
  }
}

/**
 * A deliberately partial .gitignore reader: the root file only, no negation, no
 * nested .gitignore files. Full gitignore semantics are a project of their own;
 * a missed ignore costs one listed file, while shelling out to git would cost a
 * subprocess on every glob and grep call.
 */
export async function loadGitignore(
  root: string,
): Promise<(rel: string, isDir: boolean) => boolean> {
  const raw = await readFile(join(root, '.gitignore'), 'utf8').catch(() => '');
  const patterns = raw
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#') && !line.startsWith('!'))
    .map((line) => line.replace(/\/+$/, '').replace(/^\//, ''));

  if (patterns.length === 0) return () => false;
  const matchers = patterns.map((pattern) => globToRegExp(pattern));

  return (rel) => {
    // A directory entry is matched by its own path; files under an ignored
    // directory never come up, because the walk stops descending into it.
    for (const matcher of matchers) if (matcher.test(rel)) return true;
    return false;
  };
}
