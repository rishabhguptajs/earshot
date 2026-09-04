import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { configDir } from '@earshot/providers';

/**
 * One remembered preference.
 *
 * Provenance is the reason this is a store of its own rather than lines appended
 * to AGENTS.md. A rule the user cannot trace back to something they said is a
 * rule they cannot judge, so every memory records the sentence it came from and
 * when - and `/memory` can show and delete exactly that.
 */
export interface Memory {
  id: string;
  scope: MemoryScope;
  /** The rule itself, in the imperative, as it will be given to the model. */
  text: string;
  /** What the user actually said, verbatim. */
  source: string;
  created: string;
  path: string;
}

export type MemoryScope = 'user' | 'project';

export interface NewMemory {
  text: string;
  source: string;
  scope: MemoryScope;
}

export function memoryDir(scope: MemoryScope, cwd: string): string {
  return scope === 'user' ? join(configDir(), 'memories') : join(cwd, '.earshot', 'memories');
}

/**
 * Reads both scopes, user first so a project memory is read last and wins.
 *
 * An unreadable or malformed file is skipped rather than failing the session:
 * these are hand-editable by design, and a typo in one of them must not be able
 * to stop the agent from starting.
 */
export async function loadMemories(cwd: string): Promise<Memory[]> {
  const memories: Memory[] = [];
  for (const scope of ['user', 'project'] as MemoryScope[]) {
    const dir = memoryDir(scope, cwd);
    const names = await readdir(dir).catch(() => [] as string[]);
    for (const name of names.sort()) {
      if (!name.endsWith('.md')) continue;
      const path = join(dir, name);
      const raw = await readFile(path, 'utf8').catch(() => undefined);
      if (raw === undefined) continue;
      const parsed = parseMemory(raw, path, scope);
      if (parsed) memories.push(parsed);
    }
  }
  return memories;
}

export async function saveMemory(memory: NewMemory, cwd: string): Promise<Memory> {
  const dir = memoryDir(memory.scope, cwd);
  await mkdir(dir, { recursive: true });

  const id = memoryId(memory.text);
  const created = new Date().toISOString();
  const path = join(dir, `${id}.md`);
  const body = [
    '---',
    `id: ${id}`,
    `created: ${created}`,
    `source: ${quote(memory.source)}`,
    '---',
    '',
    memory.text.trim(),
    '',
  ].join('\n');

  await writeFile(path, body, 'utf8');
  return {
    id,
    scope: memory.scope,
    text: memory.text.trim(),
    source: memory.source,
    created,
    path,
  };
}

export async function deleteMemory(id: string, cwd: string): Promise<boolean> {
  for (const scope of ['user', 'project'] as MemoryScope[]) {
    const path = join(memoryDir(scope, cwd), `${id}.md`);
    const gone = await rm(path).then(
      () => true,
      () => false,
    );
    if (gone) return true;
  }
  return false;
}

/**
 * Renders the index that sits in the system prompt on every turn.
 *
 * The id is included because the model is asked to name it when a memory changes
 * what it does - "applying your rule: use bun, not npm" is only checkable if the
 * user can go and look at that rule.
 */
export function renderMemories(memories: Memory[]): string {
  if (memories.length === 0) return '';
  const lines = memories.map(
    (memory) => `- [${memory.id}] (${memory.scope}) ${memory.text.replace(/\n+/g, ' ')}`,
  );
  return (
    'Preferences the user has asked you to remember. They are instructions, not ' +
    'suggestions, and they outrank your defaults. When one of them changes what you do, ' +
    'say so in one short clause naming it, so the user can see which rule acted and ' +
    `remove it if it is wrong.\n\n<preferences>\n${lines.join('\n')}\n</preferences>`
  );
}

/** A stable, readable file name derived from the rule itself. */
export function memoryId(text: string): string {
  const slug = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .split('-')
    .slice(0, 6)
    .join('-');
  return slug === '' ? `memory-${Date.now().toString(36)}` : slug;
}

/**
 * Frontmatter, hand-parsed.
 *
 * A YAML dependency would buy nothing here: these files have three scalar keys,
 * and the failure mode of a real parser - throwing on a file a user hand-edited
 * slightly wrong - is worse than ignoring a key we do not recognise.
 */
function parseMemory(raw: string, path: string, scope: MemoryScope): Memory | undefined {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(raw);
  if (!match) return undefined;
  const [, front = '', body = ''] = match;

  const fields = new Map<string, string>();
  for (const line of front.split(/\r?\n/)) {
    const at = line.indexOf(':');
    if (at <= 0) continue;
    fields.set(line.slice(0, at).trim(), unquote(line.slice(at + 1).trim()));
  }

  const text = body.trim();
  if (text === '') return undefined;
  const id = fields.get('id') ?? (path.split(/[/\\]/).pop() ?? '').replace(/\.md$/, '');
  return {
    id,
    scope,
    text,
    source: fields.get('source') ?? '',
    created: fields.get('created') ?? '',
    path,
  };
}

function quote(value: string): string {
  return JSON.stringify(value.replace(/\s+/g, ' ').trim());
}

function unquote(value: string): string {
  if (!value.startsWith('"')) return value;
  try {
    return JSON.parse(value) as string;
  } catch {
    return value.slice(1, -1);
  }
}
