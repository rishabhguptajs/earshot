import type { ToolDefinition, ToolResultOutput } from '@earshot/providers';
import type { ScopeContract } from '../scope/contract.ts';
import type { BackgroundJobs } from './jobs.ts';

/**
 * A permission-relevant description of what a call is about to do. The gate sees
 * only this, never the tool itself, so a new tool cannot accidentally bypass the
 * rules by forgetting to describe itself: `permission()` is required on every
 * tool that is not `readOnly`.
 */
export interface PermissionRequest {
  /** Rule name the pattern matches against, e.g. `Bash`, `Edit`, `Write`. */
  tool: string;
  /** The string a rule pattern is matched against: a command, or a path. */
  target: string;
  /** One line for the prompt header, e.g. `git status`. */
  title: string;
  /** The full command, or a unified diff. Shown verbatim - never a summary. */
  detail: string;
  /** Absolute paths this call writes to. Writes outside cwd always prompt. */
  writes?: string[];
}

export interface ToolContext {
  cwd: string;
  signal: AbortSignal;
  /** Asks the user a question mid-turn; resolves with their answer. */
  ask(question: string, options?: string[]): Promise<string>;
  /** Session-scoped todo list, shared by the `todo` tool and the status line. */
  todos: TodoStore;
  /** Session-scoped background processes started by `bash`. */
  jobs: BackgroundJobs;
  /** What the agent declared it would change, and the guard that holds it to it. */
  scope: ScopeContract;
  /**
   * Runs a nested agent with its own context window and returns its answer. It
   * inherits the session's permission rules, scope contract and cost; absent
   * when the session cannot nest one, which includes inside a subagent.
   */
  runSubagent?(request: SubagentRequest, signal: AbortSignal): Promise<SubagentResult>;
  /**
   * Narrows the tools offered to the model for the rest of the turn. Only ever
   * a restriction: the names are intersected with what the session already
   * allows, so nothing here can grant a tool the user did not.
   */
  restrictTools?(names: string[] | undefined): void;
  /** Records that a file was read, so `edit`/`write` can require a prior read. */
  markRead(path: string): void;
  hasRead(path: string): boolean;
  env: NodeJS.ProcessEnv;
}

export interface SubagentRequest {
  /** One line naming the sub-task, for the prompt and the transcript. */
  description: string;
  /** The whole task: a subagent sees none of the parent's conversation. */
  prompt: string;
  /** Tools it may use. Intersected with the parent's; never a superset. */
  tools?: string[];
}

export interface SubagentResult {
  /** What it answered. The parent gets this, never the subagent's transcript. */
  text: string;
  steps: number;
  costUsd: number;
  /** Set when it stopped for a reason other than finishing. */
  stoppedBecause?: 'aborted' | 'max_steps' | 'error';
}

export interface TodoItem {
  id: string;
  text: string;
  status: 'pending' | 'in_progress' | 'done';
}

export interface TodoStore {
  list(): TodoItem[];
  replace(items: TodoItem[]): void;
}

export interface ToolResult {
  output: ToolResultOutput;
  isError?: boolean;
  /** One line for the collapsed tool block in the TUI. */
  title?: string;
}

export interface Tool<Input = unknown> {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  /**
   * Read-only calls are executed in parallel; everything else is serialised, in
   * the order the model emitted it. A tool that mutates anything - the file
   * system, the network, a process - is not read-only.
   */
  readOnly: boolean;
  /** Throws `ToolInputError` when the model sends something unusable. */
  parse(input: unknown): Input;
  /** Required unless `readOnly`; enforced by `defineTool`. */
  permission?(input: Input, ctx: ToolContext): PermissionRequest;
  execute(input: Input, ctx: ToolContext): Promise<ToolResult>;
}

export class ToolInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ToolInputError';
  }
}

/** Fails loudly at construction rather than letting a mutating tool skip the gate. */
export function defineTool<Input>(tool: Tool<Input>): Tool<Input> {
  if (!tool.readOnly && !tool.permission) {
    throw new Error(`tool "${tool.name}" mutates state but declares no permission()`);
  }
  return tool;
}

export function toolDefinition(tool: Tool<never>): ToolDefinition {
  return { name: tool.name, description: tool.description, inputSchema: tool.inputSchema };
}

export function text(value: string): ToolResultOutput {
  return { type: 'text', value };
}
