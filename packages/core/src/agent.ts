import type {
  EarshotError,
  Message,
  ProviderRegistry,
  ToolCallPart,
  ToolDefinition,
  ToolResultOutput,
  ToolResultPart,
  Usage,
} from '@earshot/providers';
import {
  type CompactionPolicy,
  compact,
  DEFAULT_SHAPER_OPTIONS,
  estimateTokens,
  type ShaperOptions,
  SUMMARY_PROMPT,
  shapeMessages,
  shouldCompact,
} from './context/index.ts';
import type { HookEvent } from './hooks/config.ts';
import type { HookOutcome } from './hooks/run.ts';
import type { HookRunner } from './hooks/runner.ts';
import type { ResolvedModel } from './model.ts';
import { streamModel, turnCost } from './model.ts';
import {
  decide,
  type PermissionMode,
  type PermissionPrompt,
  ruleFromChoice,
} from './permissions/engine.ts';
import type { Rule } from './permissions/rules.ts';
import { persistRule } from './permissions/settings.ts';
import { type ScopeConcern, ScopeContract, type ScopeOptions } from './scope/index.ts';
import { narrow } from './skills/discover.ts';
import { BUILTIN_TOOLS, ToolRegistry } from './tools/index.ts';
import { BackgroundJobs } from './tools/jobs.ts';
import { DEFAULT_SUBAGENT_TOOLS } from './tools/task.ts';
import { MemoryTodoStore } from './tools/todo.ts';
import {
  type PermissionRequest,
  type SubagentRequest,
  type SubagentResult,
  type Tool,
  type ToolContext,
  ToolInputError,
  type ToolResult,
} from './tools/types.ts';
import type { ShadowGit, SnapshotFile } from './undo/shadow-git.ts';
import { detectTestCommand, runVerification, type VerificationResult } from './verify/index.ts';

/** Everything the TUI and the headless renderer need to show a turn. */
export type AgentEvent =
  | { type: 'model_start'; model: string }
  | { type: 'text_delta'; text: string }
  | { type: 'reasoning_delta'; text: string }
  | { type: 'message'; message: Message }
  | { type: 'tool_start'; call: ToolCallPart }
  | { type: 'tool_end'; toolCallId: string; toolName: string; result: ToolResult }
  | { type: 'permission'; request: PermissionRequest; reason: string }
  | { type: 'usage'; usage: Usage; costUsd: number }
  | { type: 'compacted'; replaced: number; summary: string }
  | { type: 'scope_concern'; concern: ScopeConcern; accepted: boolean }
  | { type: 'verification'; result: VerificationResult }
  | { type: 'hook'; event: HookEvent; blocked?: string; problems: string[] }
  | { type: 'subagent'; description: string; steps: number; costUsd: number }
  | { type: 'turn_end'; reason: 'stop' | 'aborted' | 'max_steps' | 'error' }
  | { type: 'error'; error: EarshotError };

export interface AgentOptions {
  registry: ProviderRegistry;
  model: ResolvedModel;
  cwd: string;
  system: string;
  mode: PermissionMode;
  rules: Rule[];
  /** Called when a call needs approval. Without one, every ask becomes a denial. */
  prompt?: PermissionPrompt;
  /** Called by the `ask_user` tool. Without one, the tool reports it cannot ask. */
  ask?: (question: string, options?: string[]) => Promise<string>;
  tools?: Tool<never>[];
  /** Guards against a model that loops on tools forever. */
  maxSteps?: number;
  env?: NodeJS.ProcessEnv;
  /** Called with every message appended to history, for session persistence. */
  onMessage?: (message: Message) => void | Promise<void>;
  /** Snapshot store for undo. Absent means this session keeps no undo history. */
  shadow?: ShadowGit;
  /** Overrides for the context shapers. */
  shapers?: Partial<ShaperOptions>;
  compaction?: Partial<CompactionPolicy>;
  /**
   * Called when compaction has written a summary, so the session can append a
   * `summary` entry. The entry records what was summarised; it removes nothing.
   */
  onCompaction?: (summary: string, historyCut: number) => void | Promise<void>;
  /** Overrides for the scope guard. */
  scope?: Partial<ScopeOptions>;
  /**
   * Running the project's tests after a turn that changed files, and reporting
   * what they printed. `enabled: false` turns it off; `command` overrides
   * detection.
   */
  verify?: { enabled?: boolean; command?: string; timeoutMs?: number };
  /** User-configured hooks. Absent means nothing is hooked and nothing is run. */
  hooks?: HookRunner;
  /**
   * Shared rather than constructed, so a subagent is held to the same scope the
   * parent declared. A subagent with a scope of its own would be a hole straight
   * through the contract: the parent says which files it will touch, and then
   * spawns something that never agreed to it.
   */
  scopeContract?: ScopeContract;
  /** Set on a subagent. Its cost lands on the parent's total, not beside it. */
  onCost?: (costUsd: number) => void;
  /** Steps a subagent this agent spawns may take. */
  subagentMaxSteps?: number;
}

const DEFAULT_MAX_STEPS = 100;

/**
 * The agent loop.
 *
 * History is a single flat list and is only ever appended to. That is not a
 * simplification: Anthropic rejects a request whose history contains edited
 * thinking blocks, so any feature that looks like rewriting the past (compaction,
 * rewind) has to be expressed as new entries instead. Every other provider is
 * treated as if it had the same rule, so there is one code path rather than two.
 */
export class Agent {
  readonly history: Message[] = [];
  readonly todos = new MemoryTodoStore();
  readonly scope: ScopeContract;
  readonly jobs = new BackgroundJobs();

  private readonly tools: ToolRegistry;
  private readonly readFiles = new Set<string>();
  /** Messages typed while a turn is running, injected at the next model call. */
  private readonly queued: Message[] = [];
  private rules: Rule[];
  private mode: PermissionMode;
  private totalCostUsd = 0;
  /**
   * Mutable so a memory captured mid-session applies from the next call rather
   * than from the next session - a preference the user has to restart to see
   * honoured reads as one that was ignored.
   */
  private systemPrompt: string;
  /** Pre-change hashes for the batch currently executing. */
  private batchSnapshot: SnapshotFile[] = [];
  /** Events raised while a call ran, drained by the batch loop that owns it. */
  private readonly pending: AgentEvent[] = [];
  /**
   * Where the live request starts, and what stands in for everything before it.
   * Compaction cannot shorten `history` - that would rewrite the past - so it
   * records a cut and a preamble, and the request is rebuilt from those.
   */
  private compactedAt = 0;
  private compactionPreamble: Message | undefined;
  /** Tokens in the last request actually sent, for the status line. */
  private lastRequestTokens = 0;
  /** Whether anything has been changed since the last end-of-turn check. */
  private mutatedSinceCheck = false;
  private checksThisTurn = 0;
  /**
   * Installed after construction by the TUI, which cannot supply them earlier:
   * both resolve against React state that does not exist until the app mounts.
   */
  private promptFn: PermissionPrompt | undefined;
  private askFn: ((question: string, options?: string[]) => Promise<string>) | undefined;
  /**
   * Set by a skill that declares `allowed-tools`, and cleared at the start of
   * every turn: a narrowing that outlived the task it was written for would
   * silently remove tools from work the skill knows nothing about.
   */
  private toolRestriction: string[] | undefined;

  constructor(private readonly options: AgentOptions) {
    this.tools = new ToolRegistry(options.tools ?? (BUILTIN_TOOLS as Tool<never>[]));
    this.scope = options.scopeContract ?? new ScopeContract(options.cwd, options.scope ?? {});
    this.rules = [...options.rules];
    this.mode = options.mode;
    this.promptFn = options.prompt;
    this.askFn = options.ask;
    this.systemPrompt = options.system;
  }

  /** Replaces the approval callback. Passing undefined turns every ask into a denial. */
  setPrompt(prompt: PermissionPrompt | undefined): void {
    this.promptFn = prompt;
  }

  setAsk(ask: ((question: string, options?: string[]) => Promise<string>) | undefined): void {
    this.askFn = ask;
  }

  get cwd(): string {
    return this.options.cwd;
  }

  get system(): string {
    return this.systemPrompt;
  }

  setSystem(system: string): void {
    this.systemPrompt = system;
  }

  get permissionMode(): PermissionMode {
    return this.mode;
  }

  setPermissionMode(mode: PermissionMode): void {
    this.mode = mode;
  }

  get costUsd(): number {
    return this.totalCostUsd;
  }

  /**
   * Adds to this session's spend. A subagent calls its parent's, so one session
   * has one number: a budget that a subagent could spend outside would not be a
   * budget.
   */
  private addCost(costUsd: number): void {
    this.totalCostUsd += costUsd;
    this.options.onCost?.(costUsd);
  }

  /** Estimated tokens in the last request, and the window they have to fit in. */
  get contextUse(): { tokens: number; window: number } {
    return { tokens: this.lastRequestTokens, window: this.options.model.model.contextWindow ?? 0 };
  }

  /** Files read or written this session, in the order they were first touched. */
  get touchedFiles(): string[] {
    return [...this.readFiles];
  }

  /**
   * Queues a message to be delivered at the next model call rather than
   * interrupting. This is what steering is: the user redirects the work without
   * cancelling the turn and losing everything the model has already done.
   */
  steer(text: string): void {
    this.queued.push({ role: 'user', content: [{ type: 'text', text }] });
  }

  get pendingSteers(): number {
    return this.queued.length;
  }

  /**
   * Replaces the in-memory history, for `/rewind` and `/fork`.
   *
   * The transcript on disk is untouched: rewinding points the next append at an
   * earlier entry and the abandoned branch stays in the file. What changes is
   * only which messages the next request is built from - and the compaction
   * state resets with them, since a summary of messages that are no longer in
   * the history would describe work the model can no longer see.
   */
  replaceHistory(messages: Message[]): void {
    this.history.length = 0;
    this.history.push(...messages);
    this.compactedAt = 0;
    this.compactionPreamble = undefined;
  }

  /** Ends the session's background processes. Safe to call more than once. */
  dispose(): void {
    this.jobs.killAll();
  }

  async *runTurn(prompt: string, signal: AbortSignal): AsyncGenerator<AgentEvent> {
    // The budget is per turn; the declaration outlives one, because a follow-up
    // like "now do the same for the other file" is the same piece of work.
    this.scope.beginTurn();
    this.options.hooks?.beginTurn();
    this.toolRestriction = undefined;
    this.mutatedSinceCheck = false;
    this.checksThisTurn = 0;

    const submitted = await this.options.hooks?.userPromptSubmit(prompt, signal);
    if (submitted) {
      yield hookEvent('UserPromptSubmit', submitted);
      if (submitted.decision === 'deny') {
        // The prompt is not appended at all. A blocked prompt that still entered
        // history would come back on the next request as something the user
        // asked for and the agent ignored.
        yield { type: 'turn_end', reason: 'stop' };
        return;
      }
    }

    const context = submitted?.context ?? [];
    await this.append({
      role: 'user',
      content: [
        {
          type: 'text',
          text: context.length
            ? `${prompt}\n\n<hook-context>\n${context.join('\n\n')}\n</hook-context>`
            : prompt,
        },
      ],
    });

    const maxSteps = this.options.maxSteps ?? DEFAULT_MAX_STEPS;
    const modelName = `${this.options.model.provider.id}/${this.options.model.model.id}`;

    for (let step = 0; step < maxSteps; step++) {
      if (signal.aborted) {
        yield { type: 'turn_end', reason: 'aborted' };
        return;
      }

      // Steering messages land here, between one model call and the next, which
      // is the only point where history can grow without contradicting a tool
      // call the model is still waiting on a result for.
      while (this.queued.length > 0) {
        await this.append(this.queued.shift() as Message);
      }

      for await (const event of this.prepareRequest(signal)) yield event;
      const messages = this.requestMessages();
      this.lastRequestTokens = estimateTokens(messages, this.systemPrompt);

      yield { type: 'model_start', model: modelName };

      let assistant: Message | undefined;
      let failed: EarshotError | undefined;

      for await (const event of streamModel(this.options.registry, this.options.model, {
        system: this.systemPrompt,
        messages,
        tools: this.offeredTools(),
        abortSignal: signal,
      })) {
        switch (event.type) {
          case 'text_delta':
            yield { type: 'text_delta', text: event.text };
            break;
          case 'reasoning_delta':
            yield { type: 'reasoning_delta', text: event.text };
            break;
          case 'finish': {
            assistant = event.message;
            const costUsd = turnCost(this.options.model.model, event.usage);
            this.addCost(costUsd);
            yield { type: 'usage', usage: event.usage, costUsd };
            break;
          }
          case 'error':
            failed = event.error;
            break;
          default:
            break;
        }
      }

      if (failed) {
        yield { type: 'error', error: failed };
        yield { type: 'turn_end', reason: failed.kind === 'abort' ? 'aborted' : 'error' };
        return;
      }
      if (!assistant) {
        yield { type: 'turn_end', reason: signal.aborted ? 'aborted' : 'error' };
        return;
      }

      // Appended verbatim, including providerMetadata: an assistant message that
      // is not replayed exactly is what breaks the next request on providers that
      // sign or encrypt their reasoning.
      await this.append(assistant);
      yield { type: 'message', message: assistant };

      const calls = assistant.content.filter(
        (part): part is ToolCallPart => part.type === 'tool_call',
      );
      if (calls.length === 0) {
        const check = await this.selfCheck(signal);
        if (!check) {
          const stop = await this.options.hooks?.stop(signal);
          if (stop) {
            yield hookEvent('Stop', stop);
            if (stop.decision === 'deny') {
              await this.append({
                role: 'user',
                content: [
                  {
                    type: 'text',
                    text:
                      `<hook>\nA Stop hook asked you to keep going: ${
                        stop.reason ?? 'no reason given'
                      }\nThis message is from the harness, not the user. If you believe the ` +
                      `work is finished, say so and stop.\n</hook>`,
                  },
                ],
              });
              continue;
            }
          }
          yield { type: 'turn_end', reason: 'stop' };
          return;
        }
        if (check.verification) yield { type: 'verification', result: check.verification };
        await this.append(check.message);
        continue;
      }

      const results: ToolResultPart[] = [];
      this.batchSnapshot = [];
      for await (const event of this.runCalls(calls, results, signal)) yield event;
      await this.commitSnapshot(calls);

      // Results are appended in the order the model emitted the calls, not the
      // order they finished, so a replayed transcript is deterministic even
      // though read-only calls ran concurrently.
      await this.append({ role: 'tool', content: results });

      if (signal.aborted) {
        yield { type: 'turn_end', reason: 'aborted' };
        return;
      }
    }

    yield { type: 'turn_end', reason: 'max_steps' };
  }

  /**
   * The tools this call offers the model. A skill's `allowed-tools` is applied
   * as an intersection with what the session already has, never as a union, so a
   * skill file cannot hand itself a tool the user's settings withheld.
   */
  private offeredTools(): ToolDefinition[] {
    const all = this.tools.definitions();
    if (!this.toolRestriction) return all;
    const kept = new Set(
      narrow(
        all.map((tool) => tool.name),
        this.toolRestriction,
      ),
    );
    return all.filter((tool) => kept.has(tool.name));
  }

  /**
   * Read-only calls run concurrently; anything that mutates runs one at a time.
   * Two edits to the same file in one batch would otherwise race, and the second
   * would be applied against content the first had already replaced.
   */
  private async *runCalls(
    calls: ToolCallPart[],
    into: ToolResultPart[],
    signal: AbortSignal,
  ): AsyncGenerator<AgentEvent> {
    const parallel: Array<{ index: number; promise: Promise<ToolResultPart> }> = [];
    const slots = new Array<ToolResultPart | undefined>(calls.length);

    for (const [index, call] of calls.entries()) {
      const tool = this.tools.get(call.toolName);
      if (tool?.readOnly) {
        yield { type: 'tool_start', call };
        parallel.push({ index, promise: this.runOne(tool, call, signal) });
      }
    }

    for (const [index, call] of calls.entries()) {
      const tool = this.tools.get(call.toolName);
      if (tool?.readOnly) continue;
      if (signal.aborted) break;
      yield { type: 'tool_start', call };
      const part = await this.runOne(tool, call, signal);
      slots[index] = part;
      while (this.pending.length > 0) yield this.pending.shift() as AgentEvent;
      yield {
        type: 'tool_end',
        toolCallId: call.toolCallId,
        toolName: call.toolName,
        result: asResult(part),
      };
    }

    for (const { index, promise } of parallel) {
      const part = await promise;
      slots[index] = part;
      while (this.pending.length > 0) yield this.pending.shift() as AgentEvent;
      const call = calls[index] as ToolCallPart;
      yield {
        type: 'tool_end',
        toolCallId: call.toolCallId,
        toolName: call.toolName,
        result: asResult(part),
      };
    }

    // Every call gets a result, including ones skipped by an abort: a provider
    // rejects an assistant tool call that has no matching result on the next turn.
    for (const [index, call] of calls.entries()) {
      into.push(slots[index] ?? errorPart(call, 'interrupted before this tool ran'));
    }
  }

  private async runOne(
    tool: Tool<never> | undefined,
    call: ToolCallPart,
    signal: AbortSignal,
  ): Promise<ToolResultPart> {
    if (!tool) return errorPart(call, `no tool named "${call.toolName}"`);

    let input: never;
    try {
      input = tool.parse(call.input) as never;
    } catch (error) {
      return errorPart(call, (error as Error).message);
    }

    const ctx = this.context(signal);

    // Hooks run before the gate, and can only make the answer stricter: a deny
    // stops the call, an ask turns an allow into a prompt, and an approve is
    // read, reported and ignored.
    const before = await this.options.hooks?.preToolUse(call.toolName, input, signal);
    if (before) {
      this.pending.push(hookEvent('PreToolUse', before));
      if (before.decision === 'deny') {
        return errorPart(call, before.reason ?? `a PreToolUse hook blocked ${call.toolName}`);
      }
    }

    let request: PermissionRequest | undefined;
    try {
      request = tool.permission?.(input, ctx);
    } catch (error) {
      // A permission() that throws is usually a bad path or a `find` that does not
      // match - a model error, reported as one, before the user is ever prompted.
      return errorPart(call, (error as Error).message);
    }

    let decision = decide(tool, request, {
      mode: this.mode,
      rules: this.rules,
      cwd: this.options.cwd,
    });

    if (decision.outcome === 'deny') return errorPart(call, decision.reason);

    // A hook asking for confirmation is honoured even for a read-only tool, which
    // has no PermissionRequest of its own; one is built from the call so the
    // prompt still shows what is actually about to happen.
    if (before?.decision === 'ask' && decision.outcome === 'allow') {
      const asked = request ?? {
        tool: call.toolName,
        target: call.toolName,
        title: call.toolName,
        detail: `${call.toolName}(${JSON.stringify(call.input, null, 2)})`,
      };
      decision = {
        outcome: 'ask',
        reason: before.reason ?? 'a PreToolUse hook asked for confirmation',
        request: asked,
      };
    }

    if (decision.outcome === 'ask') {
      const prompt = this.promptFn;
      if (!prompt) {
        return errorPart(
          call,
          `${decision.reason}, and this session cannot prompt for approval. Ask the user ` +
            'to re-run with a permission mode or rule that allows it.',
        );
      }
      const choice = await prompt(decision.request, decision.reason);
      if (choice.kind === 'deny') {
        return errorPart(call, choice.message ?? 'the user declined this action');
      }
      if (choice.kind === 'allow-always') {
        const rule = ruleFromChoice(decision.request, choice.scope);
        this.rules = [...this.rules, rule];
        if (choice.scope !== 'session') {
          await persistRule(rule, choice.scope, this.options.cwd).catch(() => undefined);
        }
      }
    }

    if (request) {
      const concern = this.scope.check(request);
      if (concern) {
        const accepted = await this.confirmScope(concern, request);
        this.pending.push({ type: 'scope_concern', concern, accepted });
        if (!accepted) {
          return errorPart(
            call,
            `${concern.summary} The user did not approve going outside the declared scope. ` +
              'Do the part that is in scope, and tell them what you left out and why.',
          );
        }
      }
      // Counted after approval, so the running total is what was actually done.
      this.scope.record(request);
      this.mutatedSinceCheck = true;
    }

    // Hashed here, immediately before the change and after approval, so the
    // recorded contents are what was on disk when the tool ran.
    await this.captureWrites(request?.writes ?? []);

    try {
      const result = await tool.execute(input, ctx);
      const after = await this.options.hooks?.postToolUse(
        call.toolName,
        input,
        result.output,
        signal,
      );
      if (after) this.pending.push(hookEvent('PostToolUse', after));
      return {
        type: 'tool_result',
        toolCallId: call.toolCallId,
        toolName: call.toolName,
        output: withHookContext(result.output, after?.context ?? []),
        ...(result.isError ? { isError: true } : {}),
      };
    } catch (error) {
      // A failing tool is data for the model, not a crash: it is expected to read
      // the message and try something else.
      const message =
        error instanceof ToolInputError
          ? error.message
          : `${call.toolName} failed: ${(error as Error).message}`;
      return errorPart(call, message);
    }
  }

  /**
   * Asks before doing something the turn did not say it would do.
   *
   * The prompt carries the real diff or command, exactly as an ordinary
   * permission prompt does - a scope prompt that summarised the change would
   * hide the thing the user is being asked to judge. "Always" widens the scope
   * for this session only; unlike a permission choice it persists no rule,
   * because the next task will have a different scope.
   */
  private async confirmScope(concern: ScopeConcern, request: PermissionRequest): Promise<boolean> {
    const prompt = this.promptFn;
    if (!prompt) return false;
    const choice = await prompt(
      {
        tool: 'Scope',
        target: request.target,
        title: `outside the declared scope: ${request.title}`,
        detail: `${concern.summary}\n\n${request.detail}`,
        ...(request.writes ? { writes: request.writes } : {}),
      },
      concern.summary,
    );
    if (choice.kind === 'deny') return false;
    if (choice.kind === 'allow-always') {
      this.scope.widen(concern, concern.kind === 'out-of-scope-file' ? concern.path : undefined);
    }
    return true;
  }

  /**
   * The end-of-turn check: run the project's tests, and make the model compare
   * what was asked for with what changed before it answers.
   *
   * It runs only on a turn that changed something, and at most twice, so a
   * model that keeps editing after a failure still terminates. The output is
   * handed over verbatim - a summary of it is exactly where "tests pass" from an
   * agent that never ran them hides.
   */
  private async selfCheck(
    signal: AbortSignal,
  ): Promise<{ message: Message; verification?: VerificationResult } | undefined> {
    if (!this.mutatedSinceCheck || this.checksThisTurn >= 2 || signal.aborted) return undefined;
    this.mutatedSinceCheck = false;
    this.checksThisTurn++;

    const configured = this.options.verify;
    const detected =
      configured?.enabled === false
        ? undefined
        : configured?.command
          ? { command: configured.command, source: 'configuration' }
          : await detectTestCommand(this.options.cwd);

    const verification = detected
      ? await runVerification(detected.command, detected.source, {
          cwd: this.options.cwd,
          env: this.options.env ?? process.env,
          signal,
          ...(configured?.timeoutMs !== undefined ? { timeoutMs: configured.timeoutMs } : {}),
        })
      : undefined;

    const evidence = verification
      ? `\`${verification.command}\` (from ${verification.source}) exited ` +
        `${verification.timedOut ? 'after timing out' : String(verification.exitCode)}. Its ` +
        `output, verbatim:\n\n${verification.output || '(no output)'}`
      : 'No test command was detected for this project, so nothing was verified. Say that ' +
        'plainly rather than implying the change works.';

    return {
      message: {
        role: 'user',
        content: [
          {
            type: 'text',
            text:
              `<self-check>\nThis turn changed files. Before you answer, compare the original ` +
              `request with what actually changed, and report anything you skipped, narrowed, ` +
              `left unverified or that is failing. Four of five things done is that report, ` +
              `not "done".\n\n${evidence}\n\nIf something is failing, fix it or say what is ` +
              `failing and why - do not describe the run as passing. This message is from the ` +
              `harness, not the user; answer them, not it.\n</self-check>`,
          },
        ],
      },
      ...(verification ? { verification } : {}),
    };
  }

  /** Records pre-change contents for paths not already captured in this batch. */
  private async captureWrites(paths: string[]): Promise<void> {
    const shadow = this.options.shadow;
    if (!shadow) return;
    for (const path of paths) {
      if (this.batchSnapshot.some((file) => file.path === path)) continue;
      this.batchSnapshot.push({ path, before: await shadow.hashFile(path) });
    }
  }

  /**
   * Writes one snapshot record per tool batch. Per-batch rather than per-call so
   * undo restores a coherent unit: a `multi_edit` across three files, or an edit
   * plus the command that formatted it, is one step back rather than three.
   */
  private async commitSnapshot(calls: ToolCallPart[]): Promise<void> {
    const shadow = this.options.shadow;
    if (!shadow || this.batchSnapshot.length === 0) return;
    const label = calls.map((call) => call.toolName).join(', ');
    await shadow.record(this.batchSnapshot, label).catch(() => undefined);
    this.batchSnapshot = [];
  }

  /**
   * The messages for one request: the live tail of history, any compaction
   * preamble in front of it, then the cheap shapers. A copy, never the live
   * array - an adapter that reads messages lazily would otherwise see entries
   * appended after the request was made.
   */
  private requestMessages(): Message[] {
    const tail = this.history.slice(this.compactedAt);
    const base = this.compactionPreamble ? [this.compactionPreamble, ...tail] : tail;
    return shapeMessages(base, { ...DEFAULT_SHAPER_OPTIONS, ...this.options.shapers });
  }

  /** Compacts if the shaped request would still be too large for the window. */
  private async *prepareRequest(signal: AbortSignal): AsyncGenerator<AgentEvent> {
    const window = this.options.model.model.contextWindow ?? 0;
    const policy = { threshold: 0.8, keepRecentMessages: 8, ...this.options.compaction };
    const shaped = this.requestMessages();
    if (!shouldCompact(shaped, this.systemPrompt, window, policy)) return;

    const result = await compact({
      messages: shaped,
      system: this.systemPrompt,
      contextWindow: window,
      policy,
      todos: this.todos
        .list()
        .filter((todo) => todo.status !== 'done')
        .map((todo) => todo.text),
      filesTouched: this.touchedFiles,
      summarize: (messages) => this.summarise(messages, signal),
    }).catch(() => undefined);
    if (!result) return;

    // The cut is expressed against the shaped array, which has the same length
    // and order as the tail it was built from, minus the preamble.
    const offset = this.compactionPreamble ? 1 : 0;
    this.compactedAt += Math.max(0, result.replaced - offset);
    this.compactionPreamble = result.messages[0];
    this.lastRequestTokens = estimateTokens(this.requestMessages(), this.systemPrompt);
    // The cut is reported as a history index, not as a count of shaped
    // messages: the session layer maps it back to the entry ids the summary
    // stands in for, and those are indexed by history position.
    await this.options.onCompaction?.(result.summary, this.compactedAt);
    yield { type: 'compacted', replaced: result.replaced, summary: result.summary };
  }

  /** One extra model call, with no tools: the summary that compaction stands on. */
  private async summarise(messages: Message[], signal: AbortSignal): Promise<string> {
    let text = '';
    for await (const event of streamModel(this.options.registry, this.options.model, {
      system: SUMMARY_PROMPT,
      messages: [...messages, { role: 'user', content: [{ type: 'text', text: SUMMARY_PROMPT }] }],
      abortSignal: signal,
    })) {
      if (event.type === 'text_delta') text += event.text;
      if (event.type === 'finish') {
        for (const part of event.message.content) {
          if (part.type === 'text' && text === '') text = part.text;
        }
      }
      if (event.type === 'error') throw new Error(event.error.message);
    }
    if (text.trim() === '') throw new Error('the model returned an empty summary');
    return text;
  }

  private context(signal: AbortSignal): ToolContext {
    return {
      cwd: this.options.cwd,
      signal,
      todos: this.todos,
      jobs: this.jobs,
      scope: this.scope,
      env: this.options.env ?? process.env,
      ask: async (question, choices) => {
        const ask = this.askFn;
        if (!ask) {
          throw new ToolInputError(
            'this session cannot ask the user a question; decide with the information you have ' +
              'and state the assumption you made',
          );
        }
        return ask(question, choices);
      },
      restrictTools: (names) => {
        this.toolRestriction = names;
      },
      // Absent on a subagent, so nesting stops at one level: an agent that could
      // spawn agents that spawn agents has no bound anyone can reason about.
      ...(this.options.onCost
        ? {}
        : { runSubagent: (request, sub) => this.subagent(request, sub) }),
      markRead: (path) => {
        this.readFiles.add(path);
      },
      hasRead: (path) => this.readFiles.has(path),
    };
  }

  /**
   * Runs a nested agent and returns its answer.
   *
   * What it inherits is the whole design. Permission mode and rules, so nothing
   * it does escapes the gate. The parent's ScopeContract object, so a file
   * nobody declared still prompts. The parent's cost total, so one session has
   * one number. What it does not inherit is context: it starts empty and is
   * given the prompt, which is the point - and it hands back an answer, not a
   * transcript, so the parent's window holds the conclusion rather than the
   * work.
   */
  private async subagent(request: SubagentRequest, signal: AbortSignal): Promise<SubagentResult> {
    const allowed = new Set(request.tools?.length ? request.tools : DEFAULT_SUBAGENT_TOOLS);
    // Intersection, never a union: a subagent cannot be handed a tool the parent
    // session does not have, whoever named it.
    const tools = this.tools
      .list()
      .filter((tool) => allowed.has(tool.name) && tool.name !== 'task');

    // The parent's persistence callbacks are dropped rather than passed on: a
    // subagent's messages are not the session's transcript, and writing them
    // there would replay them on the next resume as if the user had said them.
    const { onMessage: _persist, onCompaction: _summarised, ...inherited } = this.options;

    const child = new Agent({
      ...inherited,
      system:
        `${this.systemPrompt}\n\n<subagent>\nYou are running as a subagent for one ` +
        `self-contained task: ${request.description}. You cannot see the conversation that ` +
        'sent you here, and only your final message is returned - so answer in full, and ' +
        'say plainly what you could not find or could not do rather than implying success.' +
        '\n</subagent>',
      tools,
      scopeContract: this.scope,
      onCost: (costUsd) => this.addCost(costUsd),
      maxSteps: this.options.subagentMaxSteps ?? 30,
    });
    child.setPrompt(this.promptFn);
    child.setAsk(this.askFn);

    let text = '';
    let steps = 0;
    let stoppedBecause: SubagentResult['stoppedBecause'];
    const before = this.totalCostUsd;

    for await (const event of child.runTurn(request.prompt, signal)) {
      if (event.type === 'model_start') steps++;
      if (event.type === 'message') {
        const said = event.message.content
          .filter((part) => part.type === 'text')
          .map((part) => (part.type === 'text' ? part.text : ''))
          .join('');
        if (said.trim() !== '') text = said;
      }
      if (event.type === 'turn_end' && event.reason !== 'stop') stoppedBecause = event.reason;
      if (event.type === 'error') stoppedBecause = 'error';
      // Prompts and scope questions the subagent raised are the user's to see.
      if (event.type === 'permission' || event.type === 'scope_concern' || event.type === 'hook') {
        this.pending.push(event);
      }
    }
    child.dispose();

    const costUsd = this.totalCostUsd - before;
    this.pending.push({ type: 'subagent', description: request.description, steps, costUsd });
    return { text: text.trim(), steps, costUsd, ...(stoppedBecause ? { stoppedBecause } : {}) };
  }

  private async append(message: Message): Promise<void> {
    this.history.push(message);
    await this.options.onMessage?.(message);
  }
}

function hookEvent(event: HookEvent, outcome: HookOutcome): AgentEvent {
  return {
    type: 'hook',
    event,
    ...(outcome.decision === 'deny' && outcome.reason ? { blocked: outcome.reason } : {}),
    problems: outcome.problems,
  };
}

/**
 * A PostToolUse hook's output, attached to the result the model reads. Appended
 * rather than substituted: the tool's own output is what actually happened, and
 * a hook commenting on it must not be able to replace it.
 */
function withHookContext(output: ToolResultOutput, context: string[]): ToolResultOutput {
  if (context.length === 0) return output;
  const note = `<hook-context>\n${context.join('\n\n')}\n</hook-context>`;
  if (output.type === 'text') return { type: 'text', value: `${output.value}\n\n${note}` };
  return {
    type: 'content',
    value: [
      ...(output.type === 'content'
        ? output.value
        : [{ type: 'text' as const, text: JSON.stringify(output.value) }]),
      { type: 'text', text: note },
    ],
  };
}

function errorPart(call: ToolCallPart, message: string): ToolResultPart {
  return {
    type: 'tool_result',
    toolCallId: call.toolCallId,
    toolName: call.toolName,
    output: { type: 'text', value: message },
    isError: true,
  };
}

function asResult(part: ToolResultPart): ToolResult {
  return { output: part.output, ...(part.isError ? { isError: true } : {}) };
}
