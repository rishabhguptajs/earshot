import { exec } from '../tools/exec.ts';
import { resolveShell } from '../tools/shell.ts';
import type { HookDefinition, HookEvent } from './config.ts';

/** The JSON a hook reads on stdin. Field names match Claude Code's. */
export interface HookInput {
  session_id: string;
  transcript_path?: string;
  cwd: string;
  hook_event_name: HookEvent;
  tool_name?: string;
  tool_input?: unknown;
  tool_response?: unknown;
  prompt?: string;
  stop_hook_active?: boolean;
}

export interface HookOutcome {
  /**
   * What the hooks decided. `deny` blocks; `ask` forces a prompt even where a
   * rule would allow. There is no `allow`: see `applyJson`.
   */
  decision?: 'deny' | 'ask';
  reason?: string;
  /** Text to put in front of the model. */
  context: string[];
  /** Shown to the user. A hook that failed is reported, never obeyed. */
  problems: string[];
  /** A hook asked the session to stop. */
  stop?: string;
}

export const MAX_HOOK_OUTPUT_CHARS = 10_000;

const EMPTY: HookOutcome = { context: [], problems: [] };

export function matches(hook: HookDefinition, toolName: string | undefined): boolean {
  if (hook.matcher === undefined || hook.matcher === '*') return true;
  if (toolName === undefined) return false;
  try {
    return new RegExp(`^(?:${hook.matcher})$`).test(toolName);
  } catch {
    // A matcher that is not a regex is treated as a literal name rather than
    // matching everything, which is the failure that would silently run a hook
    // on every tool the agent has.
    return hook.matcher === toolName;
  }
}

export interface RunOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
  signal?: AbortSignal;
}

/**
 * Runs every hook attached to an event and folds their answers into one.
 *
 * Hooks run concurrently: they are independent, and a chain of them run in
 * series would put the sum of their timeouts in front of every tool call. A
 * hook that fails, times out, or prints something unparseable contributes a
 * problem and nothing else - the only things that can stop a tool are an
 * explicit block and exit code 2.
 */
export async function runHooks(
  hooks: HookDefinition[],
  input: HookInput,
  options: RunOptions,
): Promise<HookOutcome> {
  if (hooks.length === 0) return EMPTY;

  const shell = resolveShell(options.env);
  const payload = JSON.stringify(input);
  const outcome: HookOutcome = { context: [], problems: [] };

  const results = await Promise.all(
    hooks.map(async (hook) => {
      try {
        const result = await exec(shell.file, [...shell.args, hook.command], {
          cwd: options.cwd,
          env: options.env,
          timeoutMs: hook.timeoutMs,
          stdin: payload,
          ...(options.signal ? { signal: options.signal } : {}),
        });
        return { hook, result };
      } catch (error) {
        return { hook, failure: (error as Error).message };
      }
    }),
  );

  for (const entry of results) {
    const label = `hook ${entry.hook.event} (${entry.hook.scope}): ${entry.hook.command}`;
    if ('failure' in entry) {
      outcome.problems.push(`${label} could not run: ${entry.failure}`);
      continue;
    }
    const { result } = entry;
    if (result.timedOut) {
      outcome.problems.push(`${label} timed out and was killed; it did not block anything`);
      continue;
    }

    // Exit 2 is the blocking convention. stderr is the reason, because that is
    // where a script that means to explain itself writes.
    if (result.code === 2) {
      outcome.decision = 'deny';
      outcome.reason = cap(result.stderr.trim() || `${label} blocked this`);
      continue;
    }
    if (result.code !== 0) {
      outcome.problems.push(
        `${label} exited ${result.code ?? 'on a signal'}: ${cap(result.stderr.trim(), 500)}`,
      );
      continue;
    }

    applyJson(entry.hook, result.stdout, outcome);
  }

  return outcome;
}

/**
 * Reads a hook's stdout.
 *
 * The deliberate deviation from Claude Code is here: a hook may deny, and it may
 * downgrade an allow to a prompt, but it may never grant. `"decision": "approve"`
 * and `permissionDecision: "allow"` are read and ignored, with a line saying so.
 * A hook command lives in a settings file, including a project's checked-in one,
 * so a hook that could approve would be a repository granting itself permissions
 * the user never gave - which is the thing deny-first exists to prevent.
 */
function applyJson(hook: HookDefinition, stdout: string, outcome: HookOutcome): void {
  const text = stdout.trim();
  if (text === '') return;

  let json: Record<string, unknown> | undefined;
  if (text.startsWith('{')) {
    try {
      const parsed = JSON.parse(text) as unknown;
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
        json = parsed as Record<string, unknown>;
      }
    } catch {
      // Left undefined: unparseable output is treated as the plain text below
      // rather than as a failure, since a hook printing a log line is normal.
    }
  }

  if (!json) {
    outcome.context.push(cap(text));
    return;
  }

  const specific = (json.hookSpecificOutput ?? {}) as Record<string, unknown>;
  const granted = json.decision === 'approve' || specific.permissionDecision === 'allow';
  if (granted) {
    outcome.problems.push(
      `${hook.command} tried to approve a call; hooks in earshot can block or ask, ` +
        'never grant, so the decision was left to the permission rules',
    );
  }

  const blocked = json.decision === 'block' || specific.permissionDecision === 'deny';
  const asked = specific.permissionDecision === 'ask';
  if (blocked) {
    outcome.decision = 'deny';
    outcome.reason = cap(
      String(json.reason ?? specific.permissionDecisionReason ?? `${hook.command} blocked this`),
    );
  } else if (asked && outcome.decision !== 'deny') {
    outcome.decision = 'ask';
    outcome.reason ??= cap(String(specific.permissionDecisionReason ?? `${hook.command} asked`));
  }

  if (json.continue === false) {
    outcome.stop = cap(String(json.stopReason ?? `${hook.command} stopped the session`), 500);
  }
  if (typeof specific.additionalContext === 'string') {
    outcome.context.push(cap(specific.additionalContext));
  }
  if (typeof json.systemMessage === 'string') {
    outcome.problems.push(cap(json.systemMessage, 500));
  }
}

function cap(value: string, limit = MAX_HOOK_OUTPUT_CHARS): string {
  return value.length <= limit ? value : `${value.slice(0, limit)}\n[... truncated by earshot ...]`;
}
