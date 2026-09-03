import { buildRegistry, type ProviderRegistry } from '@earshot/providers';
import { Agent, type AgentOptions } from '../agent.ts';
import { buildSystemPrompt } from '../context/system-prompt.ts';
import { resolveModel } from '../model.ts';
import type { PermissionMode, PermissionPrompt } from '../permissions/engine.ts';
import { loadSettings } from '../permissions/settings.ts';
import { ShadowGit } from '../undo/shadow-git.ts';
import { VERSION } from '../version.ts';
import { branchTo, latestSession, messagesOf, readEntries, SessionStore } from './store.ts';

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
  };

  const agent = new Agent(agentOptions);
  // Replayed messages are pushed straight onto history rather than re-appended
  // through the store: they are already in the transcript, and writing them back
  // would duplicate every entry on each resume.
  agent.history.push(...replayed);

  return {
    agent,
    ...(store ? { store } : {}),
    problems: settings.problems,
    resumed: replayed.length,
    installPrompt: (prompt) => agent.setPrompt(prompt),
    installAsk: (ask) => agent.setAsk(ask),
    async dispose() {
      agent.dispose();
      await store?.flush();
    },
  };
}

async function resolveResumePath(options: CreateSessionOptions): Promise<string | undefined> {
  const { resume } = options;
  if (!resume) return undefined;
  if ('path' in resume) return resume.path;

  const latest = await latestSession(options.cwd);
  if (!latest) throw new NoSessionToResumeError(options.cwd);
  return latest.path;
}
