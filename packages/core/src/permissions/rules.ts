import { matchesGlob } from '../tools/glob-match.ts';

export type RuleEffect = 'allow' | 'deny' | 'ask';

/** Where a rule came from. Narrower scopes are listed first in explanations. */
export type RuleScope = 'global' | 'project' | 'local' | 'session';

export interface Rule {
  /** Tool name as written in the rule, e.g. `Bash`, `Edit`, `WebFetch`. */
  tool: string;
  /** Pattern inside the parentheses. Absent means "every use of this tool". */
  pattern?: string;
  effect: RuleEffect;
  scope: RuleScope;
  /** The rule as written, for showing the user why something was decided. */
  source: string;
}

export class RuleSyntaxError extends Error {
  constructor(rule: string, reason: string) {
    super(`bad permission rule "${rule}": ${reason}`);
    this.name = 'RuleSyntaxError';
  }
}

/**
 * Parses `Tool(pattern)` or a bare `Tool`.
 *
 * The pattern is not itself parsed here: what it means depends on the tool, and
 * a command pattern and a path pattern match very differently (see `ruleMatches`).
 */
export function parseRule(text: string, effect: RuleEffect, scope: RuleScope): Rule {
  const trimmed = text.trim();
  if (trimmed === '') throw new RuleSyntaxError(text, 'empty');

  const open = trimmed.indexOf('(');
  if (open === -1) {
    if (!/^[A-Za-z_][\w-]*$/.test(trimmed)) throw new RuleSyntaxError(text, 'not a tool name');
    return { tool: trimmed, effect, scope, source: trimmed };
  }
  if (!trimmed.endsWith(')')) throw new RuleSyntaxError(text, 'missing closing parenthesis');

  const tool = trimmed.slice(0, open).trim();
  const pattern = trimmed.slice(open + 1, -1).trim();
  if (!/^[A-Za-z_][\w-]*$/.test(tool)) throw new RuleSyntaxError(text, 'not a tool name');
  if (pattern === '') throw new RuleSyntaxError(text, 'empty pattern');

  return { tool, pattern, effect, scope, source: trimmed };
}

/**
 * Tools whose target is a path, and so is matched with path-glob semantics where
 * `*` stops at a separator. Everything else is matched as a command string.
 */
const PATH_TOOLS = new Set(['Edit', 'Write', 'Read']);

/** Operators that chain one command into another inside a single `bash` call. */
const CHAIN = /\s*(?:&&|\|\||;|\|)\s*/;

export function ruleMatches(rule: Rule, tool: string, target: string): boolean {
  if (rule.tool !== tool) return false;
  if (rule.pattern === undefined) return true;

  if (PATH_TOOLS.has(rule.tool)) return matchesGlob(rule.pattern, target);

  // A command is only covered when *every* segment of it is covered. Without
  // this, `Bash(npm run *)` would allow `npm run build && rm -rf ~`, because the
  // string does start with the approved prefix. Splitting is deliberately
  // conservative: an operator inside a quoted argument produces extra segments
  // that fail to match, which over-prompts rather than under-prompts.
  const segments = target.split(CHAIN).filter((segment) => segment.trim() !== '');
  if (segments.length === 0) return false;
  return segments.every((segment) => matchesCommand(rule.pattern as string, segment.trim()));
}

/**
 * Command matching, where `*` spans anything including spaces - `git *` covers
 * `git log --oneline -5`. Path-glob semantics would stop at a separator and make
 * `Bash(git *)` fail on any command containing a path, which is most of them.
 */
export function matchesCommand(pattern: string, command: string): boolean {
  const escaped = pattern.replace(/[.+^${}()|[\]\\?]/g, '\\$&').replace(/\*/g, '[\\s\\S]*');
  return new RegExp(`^${escaped}$`).test(command);
}

/**
 * The first matching deny rule, if any. Deny is evaluated before everything else
 * and is never overridden by an allow rule at any scope, so this is checked on
 * its own rather than folded into a single ordered pass.
 */
export function firstDeny(rules: Rule[], tool: string, target: string): Rule | undefined {
  return rules.find((rule) => rule.effect === 'deny' && ruleMatches(rule, tool, target));
}

export function firstAllow(rules: Rule[], tool: string, target: string): Rule | undefined {
  return rules.find((rule) => rule.effect === 'allow' && ruleMatches(rule, tool, target));
}

export function firstAsk(rules: Rule[], tool: string, target: string): Rule | undefined {
  return rules.find((rule) => rule.effect === 'ask' && ruleMatches(rule, tool, target));
}
