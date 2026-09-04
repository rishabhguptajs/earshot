import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { configDir } from '@earshot/providers';

/** Where a server definition came from. Decides whether it starts on its own. */
export type ServerScope = 'global' | 'project' | 'local';

export interface StdioServerConfig {
  type: 'stdio';
  command: string;
  args: string[];
  env: Record<string, string>;
  cwd?: string;
}

export interface HttpServerConfig {
  type: 'http';
  url: string;
  headers: Record<string, string>;
}

export interface ServerConfig {
  name: string;
  scope: ServerScope;
  transport: StdioServerConfig | HttpServerConfig;
  /** Per-call timeout. A server that never answers must not wedge the turn. */
  timeoutMs?: number;
  /**
   * False for a project-scope server the user has not trusted. It is listed and
   * explained rather than started - see `TRUST_NOTE`.
   */
  enabled: boolean;
}

export interface LoadedMcpConfig {
  servers: ServerConfig[];
  /** Malformed entries, reported rather than silently dropped. */
  problems: string[];
}

export const PROJECT_SETTINGS = join('.earshot', 'settings.json');
export const LOCAL_SETTINGS = join('.earshot', 'settings.local.json');

export const TRUST_NOTE =
  "defined in this project's checked-in settings and not started. Run " +
  '`earshot mcp trust <name>` to allow it - a project settings file is code you ' +
  'cloned, and starting a process it names is running that code.';

/**
 * A server name becomes the prefix of every tool it contributes, so it is
 * validated rather than trusted: `__` is the namespace separator, and a name
 * containing one could otherwise be chosen to impersonate another server's
 * tools. The rest of the character set keeps a name usable in a permission rule.
 */
const NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

export function isValidServerName(name: string): boolean {
  return NAME.test(name) && !name.includes('__');
}

interface SettingsShape {
  mcpServers?: Record<string, unknown>;
  /** Names of project-scope servers the user has approved. Local scope only. */
  mcpTrust?: string[];
}

function settingsPath(scope: ServerScope, cwd: string): string {
  if (scope === 'global') return join(configDir(), 'settings.json');
  return join(cwd, scope === 'project' ? PROJECT_SETTINGS : LOCAL_SETTINGS);
}

async function read(path: string, problems: string[]): Promise<SettingsShape | undefined> {
  const raw = await readFile(path, 'utf8').catch(() => undefined);
  if (raw === undefined) return undefined;
  try {
    return JSON.parse(raw) as SettingsShape;
  } catch (error) {
    problems.push(`${path} is not valid JSON: ${(error as Error).message}`);
    return undefined;
  }
}

/**
 * Loads server definitions from global, project and local settings.
 *
 * Unlike permission rules, which are concatenated so a project cannot remove a
 * user's deny, a server is a single named thing: the narrowest scope defining a
 * name wins, so a user can point a project's `github` server at their own
 * wrapper without editing a file the repository owns.
 */
export async function loadMcpConfig(cwd: string): Promise<LoadedMcpConfig> {
  const problems: string[] = [];
  const byName = new Map<string, ServerConfig>();
  let trusted = new Set<string>();

  for (const scope of ['global', 'project', 'local'] as ServerScope[]) {
    const path = settingsPath(scope, cwd);
    const file = await read(path, problems);
    if (!file) continue;
    if (scope === 'local' && Array.isArray(file.mcpTrust)) {
      trusted = new Set(file.mcpTrust.filter((name): name is string => typeof name === 'string'));
    }
    for (const [name, raw] of Object.entries(file.mcpServers ?? {})) {
      if (!isValidServerName(name)) {
        problems.push(`${path}: "${name}" is not a usable server name`);
        continue;
      }
      const transport = parseTransport(raw, `${path}: server "${name}"`, problems);
      if (!transport) continue;
      const timeoutMs = timeoutOf(raw);
      byName.set(name, {
        name,
        scope,
        transport,
        ...(timeoutMs !== undefined ? { timeoutMs } : {}),
        enabled: true,
      });
    }
  }

  // Resolved after the merge, so a project server the user redefined locally is
  // theirs and needs no trust entry.
  const servers = [...byName.values()].map((server) =>
    server.scope === 'project' && !trusted.has(server.name)
      ? { ...server, enabled: false }
      : server,
  );
  servers.sort((a, b) => a.name.localeCompare(b.name));
  return { servers, problems };
}

function timeoutOf(raw: unknown): number | undefined {
  const value = (raw as { timeoutMs?: unknown }).timeoutMs;
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
}

function parseTransport(
  raw: unknown,
  where: string,
  problems: string[],
): StdioServerConfig | HttpServerConfig | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    problems.push(`${where} is not an object`);
    return undefined;
  }
  const entry = raw as Record<string, unknown>;
  const declared = typeof entry.type === 'string' ? entry.type : undefined;

  // `sse` is the pre-2025 transport. Named rather than ignored so a user
  // pasting an older config is told what happened instead of seeing nothing.
  if (declared === 'sse') {
    problems.push(`${where}: the sse transport is not supported; use "type": "http"`);
    return undefined;
  }

  if (declared === 'http' || (declared === undefined && typeof entry.url === 'string')) {
    if (typeof entry.url !== 'string') {
      problems.push(`${where} declares http but has no "url"`);
      return undefined;
    }
    try {
      const url = new URL(entry.url);
      if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('not http');
    } catch {
      problems.push(`${where}: "${String(entry.url)}" is not an http(s) URL`);
      return undefined;
    }
    return { type: 'http', url: entry.url, headers: stringMap(entry.headers) };
  }

  if (typeof entry.command !== 'string' || entry.command.trim() === '') {
    problems.push(`${where} has neither a "command" nor a "url"`);
    return undefined;
  }
  const args = Array.isArray(entry.args) ? entry.args.map(String) : [];
  return {
    type: 'stdio',
    command: entry.command,
    args,
    env: stringMap(entry.env),
    ...(typeof entry.cwd === 'string' ? { cwd: entry.cwd } : {}),
  };
}

function stringMap(value: unknown): Record<string, string> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {};
  const out: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item === 'string') out[key] = item;
  }
  return out;
}
