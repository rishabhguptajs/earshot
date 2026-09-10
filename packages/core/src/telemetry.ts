import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { arch, platform } from 'node:os';
import { dirname, join } from 'node:path';
import { configDir } from '@earshot/providers';
import { VERSION } from './version.ts';

export interface TelemetryState {
  enabled: boolean;
  installationId?: string;
}
export type TelemetryEventName =
  | 'telemetry_enabled'
  | 'telemetry_disabled'
  | 'session_started'
  | 'session_completed'
  | 'session_failed'
  | 'tool_used';
/** Deliberately closed schema: no caller can add arbitrary metadata. */
export interface TelemetryPayload {
  installation_id: string;
  event: TelemetryEventName;
  timestamp: string;
  version: string;
  os: 'darwin' | 'linux' | 'win32' | 'other';
  arch: 'arm64' | 'x64' | 'other';
  tool?: string;
  provider?: string;
}
const FILE = 'telemetry.json';
const ENDPOINT = 'https://earshot-telemetry.rishabhgupta4523.workers.dev/v1/events';
export function telemetryPath(dir = configDir()): string {
  return join(dir, FILE);
}
function validState(value: unknown): TelemetryState | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const state = value as Record<string, unknown>;
  if (
    typeof state.enabled !== 'boolean' ||
    (state.installationId !== undefined && typeof state.installationId !== 'string')
  )
    return undefined;
  return state.installationId &&
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      state.installationId,
    )
    ? undefined
    : (state as unknown as TelemetryState);
}
export async function loadTelemetryState(dir = configDir()): Promise<TelemetryState | undefined> {
  const raw = await readFile(telemetryPath(dir), 'utf8').catch(() => undefined);
  if (!raw) return undefined;
  try {
    return validState(JSON.parse(raw));
  } catch {
    return undefined;
  }
}
async function save(state: TelemetryState, dir = configDir()): Promise<void> {
  const path = telemetryPath(dir);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
}
export async function setTelemetryEnabled(
  enabled: boolean,
  dir = configDir(),
): Promise<TelemetryState> {
  const state: TelemetryState = enabled
    ? { enabled: true, installationId: randomUUID() }
    : { enabled: false };
  await save(state, dir);
  return state;
}
export async function resetTelemetryIdentity(
  dir = configDir(),
): Promise<TelemetryState | undefined> {
  const state = await loadTelemetryState(dir);
  if (!state) return undefined;
  const next: TelemetryState = state.enabled
    ? { enabled: true, installationId: randomUUID() }
    : state;
  await save(next, dir);
  return next;
}
export async function clearTelemetryState(dir = configDir()): Promise<void> {
  await rm(telemetryPath(dir), { force: true });
}
function safePlatform(): TelemetryPayload['os'] {
  const value = platform();
  return value === 'darwin' || value === 'linux' || value === 'win32' ? value : 'other';
}
function safeArch(): TelemetryPayload['arch'] {
  const value = arch();
  return value === 'arm64' || value === 'x64' ? value : 'other';
}
function safeProvider(value: string): string | undefined {
  return /^[a-z0-9-]{1,40}$/i.test(value) ? value.toLowerCase() : undefined;
}
/** Best-effort, fire-and-forget. The endpoint and every payload field are fixed here. */
export class Telemetry {
  constructor(
    private readonly state: TelemetryState | undefined,
    private readonly fetcher: typeof fetch = fetch,
    private readonly endpoint = ENDPOINT,
  ) {}
  emit(event: TelemetryEventName, options: { tool?: string; provider?: string } = {}): void {
    if (!this.state?.enabled || !this.state.installationId) return;
    const tool = options.tool && /^[a-z_]{1,80}$/.test(options.tool) ? options.tool : undefined;
    const provider = options.provider ? safeProvider(options.provider) : undefined;
    const payload: TelemetryPayload = {
      installation_id: this.state.installationId,
      event,
      timestamp: new Date().toISOString(),
      version: VERSION,
      os: safePlatform(),
      arch: safeArch(),
      ...(tool ? { tool } : {}),
      ...(provider ? { provider } : {}),
    };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 1_000);
    void this.fetcher(this.endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal,
    })
      .catch(() => undefined)
      .finally(() => clearTimeout(timer));
  }
}
