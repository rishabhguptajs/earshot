import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { configDir } from '@earshot/providers';
import type { RuleScope } from '../permissions/rules.ts';
import { LOCAL_SETTINGS, PROJECT_SETTINGS } from '../permissions/settings.ts';

/**
 * The events a hook can be attached to.
 *
 * Deliberately a closed set matching Claude Code's names, so hooks people
 * already have keep working. Events earshot has no equivalent for are not
 * invented here; a hook attached to one is reported rather than silently never
 * firing.
 */
export const HOOK_EVENTS = [
  'SessionStart',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'Stop',
  'SessionEnd',
] as const;

export type HookEvent = (typeof HOOK_EVENTS)[number];

export interface HookDefinition {
  event: HookEvent;
  /** Tool-name pattern for the tool events; absent means every tool. */
  matcher?: string;
  command: string;
  timeoutMs: number;
  /** Which settings file it came from, for explaining what ran. */
  scope: RuleScope;
}

export interface LoadedHooks {
  hooks: HookDefinition[];
  problems: string[];
}

export const DEFAULT_HOOK_TIMEOUT_MS = 60_000;

interface SettingsShape {
  hooks?: Record<string, unknown>;
}

function settingsPath(scope: RuleScope, cwd: string): string {
  if (scope === 'global') return join(configDir(), 'settings.json');
  if (scope === 'project') return join(cwd, PROJECT_SETTINGS);
  return join(cwd, LOCAL_SETTINGS);
}

/**
 * Hooks from every scope, concatenated rather than overriding one another - the
 * same rule permission rules follow, and for the same reason: a project's
 * checked-in settings must not be able to remove a hook the user set globally.
 */
export async function loadHooks(cwd: string): Promise<LoadedHooks> {
  const hooks: HookDefinition[] = [];
  const problems: string[] = [];

  for (const scope of ['global', 'project', 'local'] as RuleScope[]) {
    const path = settingsPath(scope, cwd);
    const raw = await readFile(path, 'utf8').catch(() => undefined);
    if (raw === undefined) continue;

    let file: SettingsShape;
    try {
      file = JSON.parse(raw) as SettingsShape;
    } catch {
      // The permission loader reports the same file; saying it twice is noise.
      continue;
    }

    for (const [event, groups] of Object.entries(file.hooks ?? {})) {
      if (!(HOOK_EVENTS as readonly string[]).includes(event)) {
        problems.push(`${path}: earshot has no "${event}" hook event, so it will never fire`);
        continue;
      }
      if (!Array.isArray(groups)) {
        problems.push(`${path}: "hooks.${event}" must be a list`);
        continue;
      }
      for (const group of groups) {
        hooks.push(...parseGroup(group, event as HookEvent, scope, path, problems));
      }
    }
  }

  return { hooks, problems };
}

function parseGroup(
  group: unknown,
  event: HookEvent,
  scope: RuleScope,
  path: string,
  problems: string[],
): HookDefinition[] {
  if (typeof group !== 'object' || group === null) {
    problems.push(`${path}: a "${event}" entry is not an object`);
    return [];
  }
  const entry = group as { matcher?: unknown; hooks?: unknown };
  const matcher =
    typeof entry.matcher === 'string' && entry.matcher !== '' ? entry.matcher : undefined;
  if (!Array.isArray(entry.hooks)) {
    problems.push(`${path}: a "${event}" entry has no "hooks" list`);
    return [];
  }

  const out: HookDefinition[] = [];
  for (const hook of entry.hooks) {
    if (typeof hook !== 'object' || hook === null) continue;
    const item = hook as { type?: unknown; command?: unknown; timeout?: unknown };
    if (item.type !== undefined && item.type !== 'command') {
      problems.push(`${path}: only "command" hooks are supported, not "${String(item.type)}"`);
      continue;
    }
    if (typeof item.command !== 'string' || item.command.trim() === '') {
      problems.push(`${path}: a "${event}" hook has no command`);
      continue;
    }
    out.push({
      event,
      ...(matcher !== undefined ? { matcher } : {}),
      command: item.command,
      // Claude Code's field is seconds; a hook config people already have must
      // not become a sixty-times-longer timeout here.
      timeoutMs:
        typeof item.timeout === 'number' && item.timeout > 0
          ? item.timeout * 1000
          : DEFAULT_HOOK_TIMEOUT_MS,
      scope,
    });
  }
  return out;
}
