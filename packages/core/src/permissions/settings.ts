import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  type CustomProviderConfig,
  configDir,
  isReasoningEffort,
  type ReasoningEffort,
} from '@earshot/providers';
import { type Curiosity, isCuriosity } from '../context/system-prompt.ts';
import { isPermissionMode, type PermissionMode } from './engine.ts';
import { parseRule, type Rule, type RuleScope, RuleSyntaxError } from './rules.ts';

export interface SettingsFile {
  permissions?: {
    allow?: string[];
    deny?: string[];
    ask?: string[];
    defaultMode?: string;
  };
  curiosity?: string;
  /** Session budget in USD. A turn stops and asks before spending past it. */
  maxCostUsd?: number;
  defaultModel?: string;
  reasoningEfforts?: Record<string, string>;
  /**
   * Forces reasoning on or off for a model, overriding what the catalog claims.
   * The catalog is a snapshot of someone else's data and it goes stale: a model
   * it thinks reasons may reject the parameter, and one it thinks cannot may
   * support it perfectly well. Without an override the user has no way out of
   * either mistake.
   */
  thinking?: Record<string, boolean>;
  pool?: PoolSettings;
}

/** How the `free` pseudo-provider behaves. Written by `earshot pool setup`. */
export interface PoolSettings {
  /** Off by default: pooling is something the user opts into, once. */
  enabled?: boolean;
  /** Per-`provider/model` rank override; lower sorts first. */
  ranking?: Record<string, number>;
  /** Leaves out free tiers documented as training on submitted data. */
  excludeTrainingProviders?: boolean;
  /** Which tier serves compaction, subagents and other internal calls. */
  internalTier?: 'best' | 'fast' | 'cheap';
  /**
   * User-supplied OpenAI-compatible endpoints. earshot ships no unofficial
   * providers; this is how anyone who wants one wires it up themselves.
   */
  endpoints?: CustomProviderConfig[];
}

export interface LoadedSettings {
  rules: Rule[];
  /** From the narrowest scope that sets one. */
  defaultMode?: PermissionMode;
  /** Preferences, like `defaultMode`: the narrowest scope that sets one wins. */
  curiosity?: Curiosity;
  maxCostUsd?: number;
  defaultModel?: string;
  reasoningEfforts: Record<string, ReasoningEffort>;
  thinking: Record<string, boolean>;
  pool: PoolSettings;
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
  let curiosity: Curiosity | undefined;
  let maxCostUsd: number | undefined;
  let defaultModel: string | undefined;
  const reasoningEfforts: Record<string, ReasoningEffort> = {};
  const thinking: Record<string, boolean> = {};
  let pool: PoolSettings = {};

  for (const scope of scopes) {
    const path = settingsPath(scope, cwd);
    const file = await readSettings(path).catch((error: Error) => {
      problems.push(error.message);
      return undefined;
    });
    if (!file) continue;

    if (typeof file.defaultModel === 'string' && file.defaultModel.trim() !== '') {
      defaultModel = file.defaultModel.trim();
    }
    for (const [model, effort] of Object.entries(file.reasoningEfforts ?? {})) {
      if (isReasoningEffort(effort)) reasoningEfforts[model] = effort;
      else problems.push(`${path}: reasoning effort for "${model}" is invalid`);
    }
    // Merged rather than replaced, so a project can add one endpoint without
    // restating the global ranking - but each key is still narrowest-wins.
    if (file.pool) {
      pool = {
        ...pool,
        ...file.pool,
        ...(file.pool.ranking ? { ranking: { ...pool.ranking, ...file.pool.ranking } } : {}),
        ...(file.pool.endpoints
          ? { endpoints: [...(pool.endpoints ?? []), ...file.pool.endpoints] }
          : {}),
      };
    }
    for (const [model, on] of Object.entries(file.thinking ?? {})) {
      if (typeof on === 'boolean') thinking[model] = on;
      else problems.push(`${path}: thinking for "${model}" must be true or false`);
    }

    if (file.curiosity !== undefined) {
      if (isCuriosity(file.curiosity)) curiosity = file.curiosity;
      else problems.push(`${path}: "${file.curiosity}" is not a curiosity level`);
    }

    if (file.maxCostUsd !== undefined) {
      if (
        typeof file.maxCostUsd === 'number' &&
        Number.isFinite(file.maxCostUsd) &&
        file.maxCostUsd > 0
      ) {
        maxCostUsd = file.maxCostUsd;
      } else {
        problems.push(`${path}: "maxCostUsd" must be a positive number of dollars`);
      }
    }

    if (!file.permissions) continue;

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
  return {
    rules,
    ...(defaultMode ? { defaultMode } : {}),
    ...(curiosity ? { curiosity } : {}),
    ...(maxCostUsd !== undefined ? { maxCostUsd } : {}),
    ...(defaultModel ? { defaultModel } : {}),
    reasoningEfforts,
    thinking,
    pool,
    problems,
  };
}

export async function persistDefaultModel(
  model: string,
  scope: Extract<RuleScope, 'global' | 'project' | 'local'>,
  cwd: string,
): Promise<string> {
  const path = settingsPath(scope, cwd);
  const existing = (await readSettings(path).catch(() => undefined)) ?? {};
  await mkdir(dirname(path), { recursive: true });
  await writeFile(
    path,
    `${JSON.stringify({ ...existing, defaultModel: model }, null, 2)}\n`,
    'utf8',
  );
  return path;
}

export async function persistReasoningEffort(
  model: string,
  effort: ReasoningEffort | undefined,
  scope: Extract<RuleScope, 'global' | 'project' | 'local'>,
  cwd: string,
): Promise<string> {
  const path = settingsPath(scope, cwd);
  const existing = (await readSettings(path).catch(() => undefined)) ?? {};
  const reasoningEfforts = { ...(existing.reasoningEfforts ?? {}) };
  if (effort === undefined) delete reasoningEfforts[model];
  else reasoningEfforts[model] = effort;
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify({ ...existing, reasoningEfforts }, null, 2)}\n`, 'utf8');
  return path;
}

/**
 * Appends one allow rule to a settings file, preserving whatever else is in it.
 * Read-modify-write rather than a rewrite from the in-memory rule set: the file
 * is the user's, and may hold settings this version does not know about.
 */
/**
 * Records a thinking override, or clears it back to whatever the catalog says.
 * Read-modify-write like its neighbours: the file is the user's and may hold
 * keys this version knows nothing about.
 */
export async function persistThinking(
  model: string,
  on: boolean | undefined,
  scope: Extract<RuleScope, 'global' | 'project' | 'local'>,
  cwd: string,
): Promise<string> {
  const path = settingsPath(scope, cwd);
  const existing = (await readSettings(path).catch(() => undefined)) ?? {};
  const thinking = { ...(existing.thinking ?? {}) };
  if (on === undefined) delete thinking[model];
  else thinking[model] = on;
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify({ ...existing, thinking }, null, 2)}\n`, 'utf8');
  return path;
}

/**
 * Merges pool settings into one scope, preserving whatever else is in the file.
 * A partial patch, because the wizard writes `enabled` and the endpoint command
 * writes `endpoints`, and neither should erase the other.
 */
export async function persistPool(
  patch: PoolSettings,
  scope: Extract<RuleScope, 'global' | 'project' | 'local'>,
  cwd: string,
): Promise<string> {
  const path = settingsPath(scope, cwd);
  const existing = (await readSettings(path).catch(() => undefined)) ?? {};
  const next: SettingsFile = { ...existing, pool: { ...(existing.pool ?? {}), ...patch } };
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  return path;
}

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
