import { createHash, randomUUID } from 'node:crypto';
import { appendFile, mkdir, readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { Message } from '@earshot/providers';
import { sessionsDir } from '@earshot/providers';

/**
 * One line of a session transcript.
 *
 * Entries form a tree rather than a list: each carries its own `id` and the `id`
 * of the entry it follows. A linear session is the degenerate case where every
 * entry has exactly one child. `/fork` and `/rewind` then become navigation -
 * appending a new entry whose parent is somewhere other than the last entry -
 * rather than rewriting the file, which is what keeps the format append-only.
 */
export type SessionEntry =
  | {
      type: 'meta';
      id: string;
      parentId: string | null;
      timestamp: string;
      cwd: string;
      model: string;
      version: string;
      /** Set when this session continues another one. */
      forkedFrom?: { sessionId: string; entryId: string };
    }
  | {
      type: 'message';
      id: string;
      parentId: string | null;
      timestamp: string;
      message: Message;
    }
  | {
      type: 'summary';
      id: string;
      parentId: string | null;
      timestamp: string;
      /** Compaction writes a new entry rather than replacing what it summarises. */
      text: string;
      replaces: string[];
    };

/** An entry as supplied by a caller; the store assigns id, parent and timestamp. */
export type NewEntry =
  | {
      type: 'meta';
      cwd: string;
      model: string;
      version: string;
      forkedFrom?: { sessionId: string; entryId: string };
    }
  | { type: 'message'; message: Message }
  | { type: 'summary'; text: string; replaces: string[] };

export interface SessionInfo {
  id: string;
  path: string;
  cwd: string;
  model: string;
  updatedAt: number;
  /** First user message, for showing the user which session is which. */
  preview: string;
}

/**
 * Sessions are grouped by a hash of the working directory so `--continue` finds
 * the last session for *this* project. The hash is truncated: it disambiguates
 * directories, and a full digest makes the path unreadable for no benefit.
 */
/**
 * Session ids sort in creation order.
 *
 * A bare UUID does not, and file mtimes tie when two sessions are written in the
 * same millisecond - which makes `--continue` pick an arbitrary one of them. A
 * base36 timestamp plus a per-process counter gives a total order for sessions
 * started by one process, and the timestamp orders the rest.
 */
let created = 0;

export function newSessionId(): string {
  const stamp = Date.now().toString(36).padStart(9, '0');
  const seq = (created++ % 46_656).toString(36).padStart(3, '0');
  return `${stamp}${seq}-${randomUUID().slice(0, 8)}`;
}

export function projectKey(cwd: string): string {
  return createHash('sha256').update(cwd).digest('hex').slice(0, 16);
}

export function projectDir(cwd: string): string {
  return join(sessionsDir(), projectKey(cwd));
}

/**
 * Append-only JSONL writer. Every write is an `appendFile` of one line, so an
 * interrupted session leaves a truncated final line rather than a corrupt file,
 * and the reader drops exactly that line.
 */
export class SessionStore {
  private tail: string | null = null;
  private queue: Promise<void> = Promise.resolve();

  private constructor(
    readonly id: string,
    readonly path: string,
    readonly cwd: string,
  ) {}

  static async create(
    cwd: string,
    meta: {
      model: string;
      version: string;
      forkedFrom?: { sessionId: string; entryId: string };
    },
  ): Promise<SessionStore> {
    const id = newSessionId();
    const dir = projectDir(cwd);
    await mkdir(dir, { recursive: true });

    const store = new SessionStore(id, join(dir, `${id}.jsonl`), cwd);
    await store.append({
      type: 'meta',
      cwd,
      model: meta.model,
      version: meta.version,
      ...(meta.forkedFrom ? { forkedFrom: meta.forkedFrom } : {}),
    });
    return store;
  }

  /** Reopens an existing session for appending, continuing from its last entry. */
  static async open(path: string): Promise<SessionStore> {
    const entries = await readEntries(path);
    const meta = entries.find((entry) => entry.type === 'meta');
    if (meta?.type !== 'meta') throw new Error(`${path} has no session header`);

    const id =
      path
        .split(/[/\\]/)
        .pop()
        ?.replace(/\.jsonl$/, '') ?? randomUUID();
    const store = new SessionStore(id, path, meta.cwd);
    store.tail = entries.at(-1)?.id ?? null;
    return store;
  }

  /**
   * Appends one entry. Writes are serialised through a promise chain: two
   * concurrent appends could otherwise interleave partial lines, and both would
   * claim the same parent.
   */
  append(entry: NewEntry, parentId?: string | null): Promise<string> {
    const id = randomUUID();

    this.queue = this.queue.then(async () => {
      // The parent is read inside the queued task, not when append() was called.
      // Reading it eagerly would give every concurrent append the same parent, so
      // twenty writes would land as twenty siblings of one entry rather than as a
      // chain - and replaying the branch would recover only the last of them.
      const line = {
        ...entry,
        id,
        parentId: parentId !== undefined ? parentId : this.tail,
        timestamp: new Date().toISOString(),
      };
      await appendFile(this.path, `${JSON.stringify(line)}\n`, 'utf8');
      this.tail = id;
    });
    return this.queue.then(() => id);
  }

  appendMessage(message: Message): Promise<string> {
    return this.append({ type: 'message', message });
  }

  /** Resolves once every queued write has landed. */
  flush(): Promise<void> {
    return this.queue;
  }
}

/**
 * Reads a transcript, skipping unparseable lines rather than failing.
 *
 * A truncated last line is the normal result of a session that was killed
 * mid-write, and refusing to open the file would lose the entire history over
 * one incomplete entry.
 */
export async function readEntries(path: string): Promise<SessionEntry[]> {
  const raw = await readFile(path, 'utf8');
  const entries: SessionEntry[] = [];
  for (const line of raw.split('\n')) {
    if (line.trim() === '') continue;
    try {
      entries.push(JSON.parse(line) as SessionEntry);
    } catch {
      // A partial line: nothing after it can be read either, so stop here.
      break;
    }
  }
  return entries;
}

/**
 * Walks from `leaf` back to the root, so a forked session replays the branch it
 * actually descends from rather than every entry in the file.
 */
export function branchTo(entries: SessionEntry[], leafId?: string): SessionEntry[] {
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  let cursor = leafId ?? entries.at(-1)?.id;
  const branch: SessionEntry[] = [];
  const seen = new Set<string>();

  while (cursor !== undefined && cursor !== null) {
    const entry = byId.get(cursor);
    // A cycle can only come from a corrupted file, but walking one forever is a
    // hang rather than an error, so it is guarded explicitly.
    if (!entry || seen.has(entry.id)) break;
    seen.add(entry.id);
    branch.push(entry);
    cursor = entry.parentId ?? undefined;
  }
  return branch.reverse();
}

/** The messages of one branch, in order, ready to seed a resumed agent. */
export function messagesOf(entries: SessionEntry[]): Message[] {
  return entries
    .filter((entry): entry is SessionEntry & { type: 'message' } => entry.type === 'message')
    .map((entry) => entry.message);
}

export async function listSessions(cwd: string): Promise<SessionInfo[]> {
  const dir = projectDir(cwd);
  const names = await readdir(dir).catch(() => []);
  const infos: SessionInfo[] = [];

  for (const name of names) {
    if (!name.endsWith('.jsonl')) continue;
    const path = join(dir, name);
    const [info, entries] = await Promise.all([
      stat(path).catch(() => undefined),
      readEntries(path).catch(() => []),
    ]);
    const meta = entries.find((entry) => entry.type === 'meta');
    if (!info || meta?.type !== 'meta') continue;

    infos.push({
      id: name.replace(/\.jsonl$/, ''),
      path,
      cwd: meta.cwd,
      model: meta.model,
      updatedAt: info.mtimeMs,
      preview: firstUserText(entries),
    });
  }
  // Tie-broken by id, which encodes creation order, so two sessions written in
  // the same millisecond still resolve to a stable "most recent".
  return infos.sort((a, b) => b.updatedAt - a.updatedAt || b.id.localeCompare(a.id));
}

export async function latestSession(cwd: string): Promise<SessionInfo | undefined> {
  return (await listSessions(cwd))[0];
}

function firstUserText(entries: SessionEntry[]): string {
  for (const entry of entries) {
    if (entry.type !== 'message' || entry.message.role !== 'user') continue;
    for (const part of entry.message.content) {
      if (part.type === 'text' && part.text.trim() !== '') {
        return part.text.split('\n')[0]?.slice(0, 120) ?? '';
      }
    }
  }
  return '(no prompt)';
}
