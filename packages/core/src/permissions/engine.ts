import { isInside } from '../tools/fs-paths.ts';
import type { PermissionRequest, Tool } from '../tools/types.ts';
import { firstAllow, firstAsk, firstDeny, type Rule, type RuleScope } from './rules.ts';

/**
 * How much the agent may do without asking.
 *
 * - `plan`      - read and search only; every mutating tool is refused, so the
 *                 model produces a plan instead of changes.
 * - `ask`       - the default. Anything mutating prompts unless a rule allows it.
 * - `accept-edits` - file edits inside the working directory go through; commands
 *                 and network access still prompt.
 * - `auto`      - anything not explicitly denied goes through.
 * - `yolo`      - no prompts at all, including writes outside the working
 *                 directory. Deny rules still apply: they are the one thing that
 *                 no mode overrides.
 */
export type PermissionMode = 'plan' | 'ask' | 'accept-edits' | 'auto' | 'yolo';

export const PERMISSION_MODES: PermissionMode[] = ['plan', 'ask', 'accept-edits', 'auto', 'yolo'];

export function isPermissionMode(value: string): value is PermissionMode {
  return (PERMISSION_MODES as string[]).includes(value);
}

export type Decision =
  | { outcome: 'allow'; reason: string }
  | { outcome: 'deny'; reason: string }
  | { outcome: 'ask'; reason: string; request: PermissionRequest };

/** Tools that edit files, as opposed to running commands or reaching the network. */
const EDIT_TOOLS = new Set(['Edit', 'Write']);

export interface GateOptions {
  mode: PermissionMode;
  rules: Rule[];
  cwd: string;
}

/**
 * Decides one tool call. Pure: it reads rules and the request and returns a
 * decision, so the whole policy is testable without a terminal attached.
 *
 * Order is the policy, and it is deliberately not "most specific wins":
 *
 * 1. A matching deny rule refuses, always. No mode and no allow rule overrides it.
 * 2. Read-only tools never prompt.
 * 3. `plan` refuses every mutating tool.
 * 4. A write outside the working directory prompts, whatever the rules say,
 *    unless the user has explicitly chosen `yolo`.
 * 5. `yolo` allows.
 * 6. A matching ask rule prompts even when a later allow rule would match.
 * 7. A matching allow rule allows.
 * 8. Otherwise the mode decides.
 */
export function decide(
  tool: Tool<never>,
  request: PermissionRequest | undefined,
  options: GateOptions,
): Decision {
  const { mode, rules, cwd } = options;

  if (request) {
    const denied = firstDeny(rules, request.tool, request.target);
    if (denied) {
      return { outcome: 'deny', reason: `denied by rule ${denied.source} (${denied.scope})` };
    }
  }

  if (tool.readOnly || !request) {
    return { outcome: 'allow', reason: 'read-only' };
  }

  if (mode === 'plan') {
    return {
      outcome: 'deny',
      reason:
        `${tool.name} changes state, and the session is in plan mode. Present the plan ` +
        'and let the user approve it; do not try another tool to work around this.',
    };
  }

  const outside = (request.writes ?? []).filter((path) => !isInside(cwd, path));
  if (outside.length > 0 && mode !== 'yolo') {
    // Not overridable by an allow rule: a project's own settings file must not be
    // able to grant that project write access to the rest of the machine.
    return {
      outcome: 'ask',
      reason: `writes outside the working directory: ${outside.join(', ')}`,
      request,
    };
  }

  if (mode === 'yolo') return { outcome: 'allow', reason: 'yolo mode' };

  const asked = firstAsk(rules, request.tool, request.target);
  if (asked) {
    return { outcome: 'ask', reason: `rule ${asked.source} (${asked.scope})`, request };
  }

  const allowed = firstAllow(rules, request.tool, request.target);
  if (allowed) {
    return { outcome: 'allow', reason: `allowed by rule ${allowed.source} (${allowed.scope})` };
  }

  if (mode === 'auto') return { outcome: 'allow', reason: 'auto mode' };
  if (mode === 'accept-edits' && EDIT_TOOLS.has(request.tool)) {
    return { outcome: 'allow', reason: 'accept-edits mode' };
  }

  return { outcome: 'ask', reason: 'no rule covers this', request };
}

/** What the user picked at a prompt. */
export type PromptChoice =
  | { kind: 'allow-once' }
  | { kind: 'allow-always'; scope: RuleScope }
  | { kind: 'deny'; message?: string };

/**
 * Asks the user. The prompt must show `request.detail` - the real command or the
 * real diff - because a prompt showing a paraphrase is one people learn to
 * approve without reading.
 */
export type PermissionPrompt = (
  request: PermissionRequest,
  reason: string,
) => Promise<PromptChoice>;

/** Turns "always allow this" into the rule that will be persisted. */
export function ruleFromChoice(request: PermissionRequest, scope: RuleScope): Rule {
  // The rule generalises to the tool's whole target rather than to a wildcard: a
  // user approving `git status` has not approved `git push --force`.
  const source = `${request.tool}(${request.target})`;
  return { tool: request.tool, pattern: request.target, effect: 'allow', scope, source };
}
