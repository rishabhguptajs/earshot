import { readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, parse, relative, sep } from 'node:path';
import { configDir } from '@earshot/providers';

/** Checked in each directory, in order. The first that exists in a directory wins. */
export const MEMORY_FILENAMES = ['AGENTS.md', 'CLAUDE.md'];

export interface MemoryFile {
  path: string;
  content: string;
  /** `user` for the one in the config directory, `project` for the rest. */
  scope: 'user' | 'project';
}

async function readIfPresent(path: string): Promise<string | undefined> {
  const info = await stat(path).catch(() => undefined);
  if (!info?.isFile()) return undefined;
  const content = await readFile(path, 'utf8').catch(() => undefined);
  return content?.trim() === '' ? undefined : content;
}

async function readDirectory(dir: string): Promise<{ path: string; content: string } | undefined> {
  for (const name of MEMORY_FILENAMES) {
    const path = join(dir, name);
    const content = await readIfPresent(path);
    // AGENTS.md wins over CLAUDE.md in the same directory rather than both being
    // loaded: a project that has both almost always has one as a pointer to the
    // other, and concatenating them duplicates every instruction.
    if (content !== undefined) return { path, content };
  }
  return undefined;
}

/** Where the walk upward stops: a repository root, or the filesystem root. */
async function isBoundary(dir: string): Promise<boolean> {
  return (await stat(join(dir, '.git')).catch(() => undefined)) !== undefined;
}

/**
 * Collects instruction files from the config directory and from every directory
 * between the repository root and `cwd`.
 *
 * Ordered outermost-first so the nearest file is read last. Nothing here resolves
 * a conflict between two files: they are concatenated, and a model reading two
 * instructions on the same subject takes the later one. Making "nearest wins"
 * mechanical would mean parsing prose, which is not something to get subtly wrong.
 */
export async function loadMemoryFiles(cwd: string): Promise<MemoryFile[]> {
  const files: MemoryFile[] = [];

  const global = await readDirectory(configDir());
  if (global) files.push({ ...global, scope: 'user' });

  const chain: string[] = [];
  let dir = cwd;
  const home = homedir();
  const { root } = parse(cwd);

  while (true) {
    chain.push(dir);
    if (await isBoundary(dir)) break;
    // Never walks past the home directory: above it the files belong to other
    // projects, or to no project at all.
    if (dir === root || dir === home) break;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  for (const directory of chain.reverse()) {
    const found = await readDirectory(directory);
    if (found) files.push({ ...found, scope: 'project' });
  }
  return files;
}

/** Renders loaded files into the system prompt, each labelled with its path. */
export function renderMemory(files: MemoryFile[], cwd: string): string {
  if (files.length === 0) return '';
  const sections = files.map((file) => {
    const label = file.scope === 'user' ? file.path : displayRelative(cwd, file.path);
    return `<memory path="${label}">\n${file.content.trim()}\n</memory>`;
  });
  return (
    'Instructions from the user and this project. They take precedence over your ' +
    'defaults. Where two conflict, the later one is nearer to the working directory ' +
    `and wins.\n\n${sections.join('\n\n')}`
  );
}

function displayRelative(cwd: string, path: string): string {
  const rel = relative(cwd, path);
  return rel.startsWith('..') ? path : rel.split(sep).join('/');
}
