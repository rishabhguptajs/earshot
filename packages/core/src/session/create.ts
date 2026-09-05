import { buildRegistry, type ProviderRegistry } from '@earshot/providers';
import { Agent, type AgentOptions } from '../agent.ts';
import { buildSystemPrompt, type Curiosity } from '../context/system-prompt.ts';
import { loadHooks } from '../hooks/config.ts';
import { HookRunner } from '../hooks/runner.ts';
import { resolveModel } from '../model.ts';
import type { PermissionMode, PermissionPrompt } from '../permissions/engine.ts';
import { loadSettings } from '../permissions/settings.ts';
import {
  discoverExtensions,
  renderSkillIndex,
  type Skill,
  type SlashCommand,
} from '../skills/discover.ts';
import { BUILTIN_TOOLS } from '../tools/index.ts';
import { skillTool } from '../tools/skill.ts';
import type { Tool } from '../tools/types.ts';
import { ShadowGit } from '../undo/shadow-git.ts';
import { VERSION } from '../version.ts';
import { repairMessage, unresolvedToolCalls } from './repair.ts';
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
  /** Overrides `curiosity` in settings. */
  curiosity?: Curiosity;
  /** Overrides `maxCostUsd` in settings. Zero or less removes the budget. */
  maxCostUsd?: number;
  /** Asked when the budget is reached; returns a higher limit, or stops. */
  confirmBudget?: (spentUsd: number, limitUsd: number) => Promise<number | undefined>;
  /**
   * Tools contributed from outside core - MCP servers today, subagents next.
   * They are appended to the built-ins and go through the same gate: core knows
   * nothing about where they came from, which is what keeps `packages/mcp`
   * depending on core rather than the other way round.
   */
  extraTools?: Tool<never>[];
  /** Additional problems to surface before the first turn, e.g. a server that failed. */
  problems?: string[];
  /** Torn down with the session, so a spawned server does not outlive it. */
  onDispose?: () => Promise<void> | void;
  /** Skips skill and slash-command discovery, for tests and one-shot runs. */
  noExtensions?: boolean;
}

export interface CreatedSession {
  agent: Agent;
  store?: SessionStore;
  /** Settings problems worth showing the user before the first turn. */
  problems: string[];
  /** Number of messages replayed from a resumed transcript. */
  resumed: number;
  /** Discovered skills, for `/skills` and for explaining what is loaded. */
  skills: Skill[];
  /** User-defined slash commands, expanded into prompts by the TUI. */
  commands: SlashCommand[];
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
  const curiosity = options.curiosity ?? settings.curiosity ?? 'normal';
  // A flag of zero or less is how the CLI says "no budget", which has to beat a
  // settings file that sets one, or a limit would be impossible to turn off.
  const maxCostUsd =
    options.maxCostUsd !== undefined
      ? options.maxCostUsd > 0
        ? options.maxCostUsd
        : undefined
      : settings.maxCostUsd;

  const resolved = await resolveModel(registry, options.model, {
    ...(options.apiKey ? { apiKey: options.apiKey } : {}),
  });
  const modelRef = `${resolved.provider.id}/${resolved.model.id}`;

  const discovered = options.noExtensions
    ? { skills: [], commands: [], problems: [] }
    : await discoverExtensions(options.cwd);

  let store: SessionStore | undefined;
  let replayed: ReturnType<typeof messagesOf> = [];
  const repairProblems: string[] = [];

  if (!options.ephemeral) {
    const resumePath = await resolveResumePath(options);
    if (resumePath) {
      const entries = await readEntries(resumePath);
      // Only the branch the transcript actually ends on: a session that was
      // rewound has entries that are no longer part of its history.
      replayed = messagesOf(branchTo(entries));
      store = await SessionStore.open(resumePath).catch(() => undefined);

      // A crash between the assistant message and its tool results leaves calls
      // with no answer, which the provider rejects on the next request - so the
      // resumed session would fail before the user typed anything. The results
      // are appended as a new entry; nothing already written is touched.
      const orphaned = unresolvedToolCalls(replayed);
      if (orphaned.length > 0) {
        const repair = repairMessage(orphaned);
        replayed = [...replayed, repair];
        if (store) await store.appendMessage(repair);
        repairProblems.push(
          `repaired an interrupted turn: ${orphaned.length} tool ` +
            `${orphaned.length === 1 ? 'call' : 'calls'} ` +
            `(${orphaned.map((call) => call.toolName).join(', ')}) had no recorded result`,
        );
      }
    }
    store ??= await SessionStore.create(options.cwd, {
      model: modelRef,
      version: VERSION,
    }).catch(() => undefined);
  }

  const loadedHooks = options.noExtensions
    ? { hooks: [], problems: [] }
    : await loadHooks(options.cwd);
  const hooks = new HookRunner(loadedHooks.hooks, {
    cwd: options.cwd,
    env: process.env,
    sessionId: store?.id ?? 'ephemeral',
    ...(store ? { transcriptPath: store.path } : {}),
  });

  // Built after the session id exists, because a SessionStart hook is told which
  // session it is running for, and its context goes into the prompt it starts.
  const started = hooks.has('SessionStart') ? await hooks.sessionStart() : undefined;
  const system = await buildSystemPrompt({
    cwd: options.cwd,
    mode,
    curiosity,
    model: modelRef,
    skills: renderSkillIndex(discovered.skills),
    ...(started?.context.length
      ? { extra: `<session-start>\n${started.context.join('\n\n')}\n</session-start>` }
      : {}),
  });

  const shadow = options.noUndo
    ? undefined
    : await ShadowGit.open(options.cwd).catch(() => undefined);

  // The skill tool only exists when there is something to load: a tool whose
  // every argument is invalid is one the model wastes a call discovering.
  const sessionTools: Tool<never>[] = [
    ...(BUILTIN_TOOLS as Tool<never>[]),
    ...(discovered.skills.length ? [skillTool(discovered.skills) as unknown as Tool<never>] : []),
    ...(options.extraTools ?? []),
  ];

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
    ...(maxCostUsd !== undefined ? { maxCostUsd } : {}),
    ...(options.confirmBudget ? { confirmBudget: options.confirmBudget } : {}),
    ...(sessionTools.length > BUILTIN_TOOLS.length ? { tools: sessionTools } : {}),
    ...(hooks.isEmpty ? {} : { hooks }),
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
    problems: [
      ...settings.problems,
      ...discovered.problems,
      ...loadedHooks.problems,
      ...(started?.problems ?? []),
      ...repairProblems,
      ...(options.problems ?? []),
    ],
    resumed: replayed.length,
    skills: discovered.skills,
    commands: discovered.commands,
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
      // Best effort: a SessionEnd hook that fails must not stop the session from
      // closing, and nothing can act on its answer by this point anyway.
      if (hooks.has('SessionEnd')) await hooks.sessionEnd().catch(() => undefined);
      await store?.flush();
      await options.onDispose?.();
    },
  };
}

/**
 * Rebuilds the system prompt from what is currently on disk.
 *
 * Called after a memory is captured or deleted, so a preference takes effect on
 * the next model call rather than the next session.
 */
export async function refreshSystemPrompt(
  agent: Agent,
  model: string,
  skills: Skill[] = [],
): Promise<void> {
  agent.setSystem(
    await buildSystemPrompt({
      cwd: agent.cwd,
      mode: agent.permissionMode,
      model,
      // Rebuilt from the same list rather than re-discovered: a skill added mid
      // session is not loaded until the next one, and a prompt that silently
      // gained an entry would be harder to explain than one that did not.
      skills: renderSkillIndex(skills),
    }),
  );
}

async function resolveResumePath(options: CreateSessionOptions): Promise<string | undefined> {
  const { resume } = options;
  if (!resume) return undefined;
  if ('path' in resume) return resume.path;

  const latest = await latestSession(options.cwd);
  if (!latest) throw new NoSessionToResumeError(options.cwd);
  return latest.path;
}
