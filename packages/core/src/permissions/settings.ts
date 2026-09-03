import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { configDir } from '@earshot/providers';
import { isPermissionMode, type PermissionMode } from './engine.ts';
import { parseRule, type Rule, type RuleScope, RuleSyntaxError } from './rules.ts';

export interface SettingsFile {
  permissions?: {
    allow?: string[];
    deny?: string[];
    ask?: string[];
    defaultMode?: string;
  };
}

export interface LoadedSettings {
  rules: Rule[];
  /** From the narrowest scope that sets one. */
  defaultMode?: PermissionMode;
  /** Rules that failed to parse, reported rather than silently dropped. */
  problems: string[];
}

export const PROJECT_SETTINGS = join('.earshot', 'settings.json');
export const LOCAL_SETTINGS = join('.earshot', 'settings.local.json');

export function settingsPath(scope: RuleScope, cwd: string): string {
  if (scope === 'global') return join(configDir(), 'settings.json');
  if (scope === 'project') return join(cwd, PROJECT_SETTINGS);
  if (scope === 'local') return join(cwd, LOCAL_SETTINGS);
  throw new Error(`scope "${scope}" is not persisted`);
}

async function readSettings(path: string): Promise<SettingsFile | undefined> {
  const raw = await readFile(path, 'utf8').catch(() => undefined);
  if (raw === undefined) return undefined;
  try {
    return JSON.parse(raw) as SettingsFile;
  } catch (error) {
    throw new Error(`${path} is not valid JSON: ${(error as Error).message}`);
  }
}

/**
 * Loads global, then project, then local settings.
 *
 * Rules from every scope are concatenated rather than overriding one another -
 * a narrower scope cannot remove a broader scope's deny rule, which is the whole
 * point of deny-first. `defaultMode` is the exception: it is a preference, not a
 * restriction, so the narrowest scope that sets one wins.
 */
export async function loadSettings(cwd: string): Promise<LoadedSettings> {
  const scopes: RuleScope[] = ['global', 'project', 'local'];
  const rules: Rule[] = [];
  const problems: string[] = [];
  let defaultMode: PermissionMode | undefined;

  for (const scope of scopes) {
    const path = settingsPath(scope, cwd);
    const file = await readSettings(path).catch((error: Error) => {
      problems.push(error.message);
      return undefined;
    });
    if (!file?.permissions) continue;

    // Deny rules are collected first within each scope so an explanation names
    // the deny rule rather than a coincidentally earlier allow rule.
    for (const [effect, list] of [
      ['deny', file.permissions.deny],
      ['ask', file.permissions.ask],
      ['allow', file.permissions.allow],
    ] as const) {
      for (const text of list ?? []) {
        try {
          rules.push(parseRule(text, effect, scope));
        } catch (error) {
          if (!(error instanceof RuleSyntaxError)) throw error;
          problems.push(`${path}: ${error.message}`);
        }
      }
    }

    const mode = file.permissions.defaultMode;
    if (mode !== undefined) {
      if (isPermissionMode(mode)) defaultMode = mode;
      else problems.push(`${path}: "${mode}" is not a permission mode`);
    }
  }

  // Deny rules sort ahead of the rest so `firstDeny` and the explanations it
  // produces are stable regardless of which scope contributed what.
  rules.sort((a, b) => Number(b.effect === 'deny') - Number(a.effect === 'deny'));
  return { rules, ...(defaultMode ? { defaultMode } : {}), problems };
}

/**
 * Appends one allow rule to a settings file, preserving whatever else is in it.
 * Read-modify-write rather than a rewrite from the in-memory rule set: the file
 * is the user's, and may hold settings this version does not know about.
 */
export async function persistRule(rule: Rule, scope: RuleScope, cwd: string): Promise<string> {
  const path = settingsPath(scope, cwd);
  const existing = (await readSettings(path).catch(() => undefined)) ?? {};

  const permissions = existing.permissions ?? {};
  const list = permissions[rule.effect] ?? [];
  if (!list.includes(rule.source)) list.push(rule.source);

  const next: SettingsFile = { ...existing, permissions: { ...permissions, [rule.effect]: list } };
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  return path;
}
