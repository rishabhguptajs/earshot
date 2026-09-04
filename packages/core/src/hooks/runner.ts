import type { HookDefinition, HookEvent } from './config.ts';
import { type HookInput, type HookOutcome, matches, runHooks } from './run.ts';

export interface HookRunnerOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
  sessionId: string;
  transcriptPath?: string;
}

const NOTHING: HookOutcome = { context: [], problems: [] };

/**
 * The agent's view of hooks: one call per event, and an outcome that says what
 * to do.
 *
 * What each event may do is the contract, and it is not symmetric:
 *
 * - `PreToolUse` may block a call or force a prompt for it. It may not approve
 *   one - see `applyJson` in run.ts for why.
 * - `UserPromptSubmit` may block the prompt, and may add context to it.
 * - `PostToolUse` may only observe and add context: the tool has already run,
 *   and a hook pretending otherwise would be lying to the model about the state
 *   of the world.
 * - `Stop` may ask for one more model call, once per turn, so a hook cannot loop
 *   the agent forever.
 * - `SessionStart` and `SessionEnd` observe.
 */
export class HookRunner {
  private stopBlocked = false;

  constructor(
    private readonly hooks: HookDefinition[],
    private readonly options: HookRunnerOptions,
  ) {}

  get isEmpty(): boolean {
    return this.hooks.length === 0;
  }

  /** True when any hook is attached to this event, so callers can skip the work. */
  has(event: HookEvent): boolean {
    return this.hooks.some((hook) => hook.event === event);
  }

  beginTurn(): void {
    this.stopBlocked = false;
  }

  async preToolUse(toolName: string, input: unknown, signal?: AbortSignal): Promise<HookOutcome> {
    return this.run('PreToolUse', toolName, { tool_name: toolName, tool_input: input }, signal);
  }

  async postToolUse(
    toolName: string,
    input: unknown,
    response: unknown,
    signal?: AbortSignal,
  ): Promise<HookOutcome> {
    const outcome = await this.run(
      'PostToolUse',
      toolName,
      { tool_name: toolName, tool_input: input, tool_response: response },
      signal,
    );
    // A PostToolUse block is downgraded to context: the call already happened,
    // and reporting it as blocked would tell the model something untrue.
    if (outcome.decision === 'deny') {
      const { decision: _blocked, reason: _reason, ...rest } = outcome;
      return {
        ...rest,
        context: [...outcome.context, outcome.reason ?? 'a hook objected to this result'],
      };
    }
    return outcome;
  }

  async userPromptSubmit(prompt: string, signal?: AbortSignal): Promise<HookOutcome> {
    return this.run('UserPromptSubmit', undefined, { prompt }, signal);
  }

  /**
   * Asks whether the turn may end. Answered at most once per turn: a hook that
   * could block every stop would keep the agent running - and spending - with no
   * way for the user to get a word in.
   */
  async stop(signal?: AbortSignal): Promise<HookOutcome> {
    if (this.stopBlocked) return NOTHING;
    const outcome = await this.run(
      'Stop',
      undefined,
      { stop_hook_active: this.stopBlocked },
      signal,
    );
    if (outcome.decision === 'deny') this.stopBlocked = true;
    return outcome;
  }

  async sessionStart(signal?: AbortSignal): Promise<HookOutcome> {
    return this.run('SessionStart', undefined, {}, signal);
  }

  async sessionEnd(): Promise<HookOutcome> {
    return this.run('SessionEnd', undefined, {});
  }

  private run(
    event: HookEvent,
    toolName: string | undefined,
    extra: Partial<HookInput>,
    signal?: AbortSignal,
  ): Promise<HookOutcome> {
    const applicable = this.hooks.filter((hook) => hook.event === event && matches(hook, toolName));
    if (applicable.length === 0) return Promise.resolve(NOTHING);

    const input: HookInput = {
      session_id: this.options.sessionId,
      ...(this.options.transcriptPath ? { transcript_path: this.options.transcriptPath } : {}),
      cwd: this.options.cwd,
      hook_event_name: event,
      ...extra,
    };
    return runHooks(applicable, input, {
      cwd: this.options.cwd,
      env: this.options.env,
      ...(signal ? { signal } : {}),
    });
  }
}
