import type {
  EarshotError,
  Message,
  ProviderRegistry,
  ToolCallPart,
  ToolResultPart,
  Usage,
} from '@earshot/providers';
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
import { BUILTIN_TOOLS, ToolRegistry } from './tools/index.ts';
import { BackgroundJobs } from './tools/jobs.ts';
import { MemoryTodoStore } from './tools/todo.ts';
import {
  type PermissionRequest,
  type Tool,
  type ToolContext,
  ToolInputError,
  type ToolResult,
} from './tools/types.ts';
import type { ShadowGit, SnapshotFile } from './undo/shadow-git.ts';

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
  readonly jobs = new BackgroundJobs();

  private readonly tools: ToolRegistry;
  private readonly readFiles = new Set<string>();
  /** Messages typed while a turn is running, injected at the next model call. */
  private readonly queued: Message[] = [];
  private rules: Rule[];
  private mode: PermissionMode;
  private totalCostUsd = 0;
  /** Pre-change hashes for the batch currently executing. */
  private batchSnapshot: SnapshotFile[] = [];
  /**
   * Installed after construction by the TUI, which cannot supply them earlier:
   * both resolve against React state that does not exist until the app mounts.
   */
  private promptFn: PermissionPrompt | undefined;
  private askFn: ((question: string, options?: string[]) => Promise<string>) | undefined;

  constructor(private readonly options: AgentOptions) {
    this.tools = new ToolRegistry(options.tools ?? (BUILTIN_TOOLS as Tool<never>[]));
    this.rules = [...options.rules];
    this.mode = options.mode;
    this.promptFn = options.prompt;
    this.askFn = options.ask;
  }

  /** Replaces the approval callback. Passing undefined turns every ask into a denial. */
  setPrompt(prompt: PermissionPrompt | undefined): void {
    this.promptFn = prompt;
  }

  setAsk(ask: ((question: string, options?: string[]) => Promise<string>) | undefined): void {
    this.askFn = ask;
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

  /** Ends the session's background processes. Safe to call more than once. */
  dispose(): void {
    this.jobs.killAll();
  }

  async *runTurn(prompt: string, signal: AbortSignal): AsyncGenerator<AgentEvent> {
    await this.append({ role: 'user', content: [{ type: 'text', text: prompt }] });

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

      yield { type: 'model_start', model: modelName };

      let assistant: Message | undefined;
      let failed: EarshotError | undefined;

      for await (const event of streamModel(this.options.registry, this.options.model, {
        system: this.options.system,
        // A copy, not the live array: an adapter that reads messages lazily would
        // otherwise see entries appended after the request was made.
        messages: [...this.history],
        tools: this.tools.definitions(),
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
            this.totalCostUsd += costUsd;
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
        yield { type: 'turn_end', reason: 'stop' };
        return;
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
    let request: PermissionRequest | undefined;
    try {
      request = tool.permission?.(input, ctx);
    } catch (error) {
      // A permission() that throws is usually a bad path or a `find` that does not
      // match - a model error, reported as one, before the user is ever prompted.
      return errorPart(call, (error as Error).message);
    }

    const decision = decide(tool, request, {
      mode: this.mode,
      rules: this.rules,
      cwd: this.options.cwd,
    });

    if (decision.outcome === 'deny') return errorPart(call, decision.reason);

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

    // Hashed here, immediately before the change and after approval, so the
    // recorded contents are what was on disk when the tool ran.
    await this.captureWrites(request?.writes ?? []);

    try {
      const result = await tool.execute(input, ctx);
      return {
        type: 'tool_result',
        toolCallId: call.toolCallId,
        toolName: call.toolName,
        output: result.output,
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

  private context(signal: AbortSignal): ToolContext {
    return {
      cwd: this.options.cwd,
      signal,
      todos: this.todos,
      jobs: this.jobs,
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
      markRead: (path) => {
        this.readFiles.add(path);
      },
      hasRead: (path) => this.readFiles.has(path),
    };
  }

  private async append(message: Message): Promise<void> {
    this.history.push(message);
    await this.options.onMessage?.(message);
  }
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
