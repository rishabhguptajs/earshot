import { buildRegistry, type ProviderRegistry } from '@earshot/providers';
import { Agent, type AgentOptions } from '../agent.ts';
import { buildSystemPrompt } from '../context/system-prompt.ts';
import { resolveModel } from '../model.ts';
import type { PermissionMode, PermissionPrompt } from '../permissions/engine.ts';
import { loadSettings } from '../permissions/settings.ts';
import { ShadowGit } from '../undo/shadow-git.ts';
import { VERSION } from '../version.ts';
import {
  branchTo,
  latestSession,
  messagesOf,
  readEntries,
  type SessionEntry,
  SessionStore,
} from './store.ts';

export interface CreateSessionOptions {
  cwd: string;
  /** Model reference; falls back to the configured default. */
  model: string;
  mode?: PermissionMode;
  apiKey?: string;
  registry?: ProviderRegistry;
  prompt?: PermissionPrompt;
  ask?: (question: string, options?: string[]) => Promise<string>;
  /** Resume a specific transcript, or the most recent one for this directory. */
  resume?: { path: string } | { latest: true };
  /** Skips session persistence entirely, for one-shot runs. */
  ephemeral?: boolean;
  /** Disables undo snapshots. */
  noUndo?: boolean;
  maxSteps?: number;
}

export interface CreatedSession {
  agent: Agent;
  store?: SessionStore;
  /** Settings problems worth showing the user before the first turn. */
  problems: string[];
  /** Number of messages replayed from a resumed transcript. */
  resumed: number;
  /** Installs the approval callback; the TUI can only build one after it mounts. */
  installPrompt(prompt: PermissionPrompt): void;
  installAsk(ask: (question: string, options?: string[]) => Promise<string>): void;
  /** The current branch of the transcript, oldest first. */
  branch(): Promise<SessionEntry[]>;
  /**
   * Moves the session back to an earlier entry. Nothing is deleted: later
   * entries stay in the file as an abandoned branch.
   */
  rewindTo(entryId: string): Promise<number>;
  /** Continues in a new transcript that records where it branched from. */
  fork(entryId?: string): Promise<string | undefined>;
  /**
   * Reverts the most recent tool batch's file changes. Calling it again steps
   * back another batch; a file the batch created is reported rather than
   * deleted.
   */
  undo(): Promise<{ label: string; restored: string[]; wasCreated: string[] } | undefined>;
  dispose(): Promise<void>;
}

export class NoSessionToResumeError extends Error {
  constructor(cwd: string) {
    super(`no previous session for ${cwd}`);
    this.name = 'NoSessionToResumeError';
  }
}

/**
 * One place that turns flags into a running agent, so the TUI and the headless
 * command cannot drift on which settings are honoured. Everything optional here
 * degrades rather than failing: a missing git binary means no undo, and an
 * unwritable data directory means no transcript, but the turn still runs.
 */
export async function createSession(options: CreateSessionOptions): Promise<CreatedSession> {
  const registry = options.registry ?? buildRegistry();
  const settings = await loadSettings(options.cwd);
  const mode = options.mode ?? settings.defaultMode ?? 'ask';

  const resolved = await resolveModel(registry, options.model, {
    ...(options.apiKey ? { apiKey: options.apiKey } : {}),
  });
  const modelRef = `${resolved.provider.id}/${resolved.model.id}`;

  const system = await buildSystemPrompt({ cwd: options.cwd, mode, model: modelRef });

  let store: SessionStore | undefined;
  let replayed: ReturnType<typeof messagesOf> = [];

  if (!options.ephemeral) {
    const resumePath = await resolveResumePath(options);
    if (resumePath) {
      const entries = await readEntries(resumePath);
      // Only the branch the transcript actually ends on: a session that was
      // rewound has entries that are no longer part of its history.
      replayed = messagesOf(branchTo(entries));
      store = await SessionStore.open(resumePath).catch(() => undefined);
    }
    store ??= await SessionStore.create(options.cwd, {
      model: modelRef,
      version: VERSION,
    }).catch(() => undefined);
  }

  const shadow = options.noUndo
    ? undefined
    : await ShadowGit.open(options.cwd).catch(() => undefined);

  const agentOptions: AgentOptions = {
    registry,
    model: resolved,
    cwd: options.cwd,
    system,
    mode,
    rules: settings.rules,
    ...(options.prompt ? { prompt: options.prompt } : {}),
    ...(options.ask ? { ask: options.ask } : {}),
    ...(options.maxSteps !== undefined ? { maxSteps: options.maxSteps } : {}),
    ...(shadow ? { shadow } : {}),
    ...(store ? { onMessage: (message) => void store?.appendMessage(message) } : {}),
    ...(store
      ? {
          // Appended, never substituted for what it summarises: the transcript
          // on disk stays complete, so a resumed session can replay the real
          // messages rather than a recollection of them.
          onCompaction: (summary: string, historyCut: number) => {
            void store?.append({
              type: 'summary',
              text: summary,
              replaces: store?.messageIds.slice(0, historyCut) ?? [],
            });
          },
        }
      : {}),
  };

  const agent = new Agent(agentOptions);
  // Replayed messages are pushed straight onto history rather than re-appended
  // through the store: they are already in the transcript, and writing them back
  // would duplicate every entry on each resume.
  agent.history.push(...replayed);

  const undone = new Set<string>();

  const branch = async (): Promise<SessionEntry[]> => {
    if (!store) return [];
    await store.flush();
    return branchTo(await readEntries(store.path), store.tailId ?? undefined);
  };

  return {
    agent,
    ...(store ? { store } : {}),
    problems: settings.problems,
    resumed: replayed.length,
    installPrompt: (prompt) => agent.setPrompt(prompt),
    installAsk: (ask) => agent.setAsk(ask),
    branch,
    async rewindTo(entryId) {
      if (!store) return 0;
      await store.flush();
      const entries = await readEntries(store.path);
      const kept = messagesOf(branchTo(entries, entryId));
      store.rewind(entryId);
      agent.replaceHistory(kept);
      return kept.length;
    },
    async fork(entryId) {
      if (!store) return undefined;
      await store.flush();
      const from = entryId ?? store.tailId;
      const entries = await readEntries(store.path);
      const forked = await SessionStore.create(options.cwd, {
        model: modelRef,
        version: VERSION,
        ...(from ? { forkedFrom: { sessionId: store.id, entryId: from } } : {}),
      }).catch(() => undefined);
      if (!forked) return undefined;

      // The branch is replayed into the new file rather than referenced across
      // it: a transcript that cannot be read on its own is one that breaks as
      // soon as the file it points at is deleted.
      const kept = messagesOf(branchTo(entries, from ?? undefined));
      for (const message of kept) await forked.appendMessage(message);
      agent.replaceHistory(kept);
      store = forked;
      return forked.id;
    },
    async undo() {
      if (!shadow) return undefined;
      // Snapshots are not consumed by restoring them, so the ones already used
      // are tracked here; without this, a second /undo replays the first.
      const snapshots = (await shadow.list()).filter((snapshot) => !undone.has(snapshot.id));
      const last = snapshots.at(-1);
      if (!last) return undefined;
      undone.add(last.id);
      const { restored, wasCreated } = await shadow.restore(last);
      return { label: last.label, restored, wasCreated };
    },
    async dispose() {
      agent.dispose();
      await store?.flush();
    },
  };
}

/**
 * Rebuilds the system prompt from what is currently on disk.
 *
 * Called after a memory is captured or deleted, so a preference takes effect on
 * the next model call rather than the next session.
 */
export async function refreshSystemPrompt(agent: Agent, model: string): Promise<void> {
  agent.setSystem(await buildSystemPrompt({ cwd: agent.cwd, mode: agent.permissionMode, model }));
}

async function resolveResumePath(options: CreateSessionOptions): Promise<string | undefined> {
  const { resume } = options;
  if (!resume) return undefined;
  if ('path' in resume) return resume.path;

  const latest = await latestSession(options.cwd);
  if (!latest) throw new NoSessionToResumeError(options.cwd);
  return latest.path;
}
