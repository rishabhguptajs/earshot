import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import {
  loadTelemetryState,
  resetTelemetryIdentity,
  setTelemetryEnabled,
  Telemetry,
} from '../src/telemetry.ts';
import { withTempDir } from './helpers.ts';

describe('telemetry', () => {
  test('disabled state makes no request', () => {
    let requests = 0;
    new Telemetry({ enabled: false }, async () => {
      requests++;
      return new Response();
    }).emit('session_started');
    expect(requests).toBe(0);
  });

  test('only the allowlisted payload is sent', async () => {
    let body: unknown;
    const id = '00000000-0000-4000-8000-000000000000';
    new Telemetry({ enabled: true, installationId: id }, async (_url, init) => {
      body = JSON.parse(init?.body as string);
      return new Response('', { status: 204 });
    }).emit('tool_used', { tool: 'read', provider: 'openai' });
    await Promise.resolve();
    expect(body).toMatchObject({
      installation_id: id,
      event: 'tool_used',
      tool: 'read',
      provider: 'openai',
    });
    expect(Object.keys(body as object).sort()).toEqual([
      'arch',
      'event',
      'installation_id',
      'os',
      'provider',
      'timestamp',
      'tool',
      'version',
    ]);
    expect(JSON.stringify(body)).not.toContain(
      'secret prompt /private/project/file.ts --api-key=abc',
    );
  });

  test('opt-in persists a random identity and reset replaces it', async () => {
    await withTempDir(async (dir) => {
      const config = join(dir, 'config');
      const enabled = await setTelemetryEnabled(true, config);
      expect((await loadTelemetryState(config))?.installationId).toBe(enabled.installationId);
      const reset = await resetTelemetryIdentity(config);
      expect(reset?.installationId).not.toBe(enabled.installationId);
      await setTelemetryEnabled(false, config);
      expect(await loadTelemetryState(config)).toEqual({ enabled: false });
    });
  });

  test('malformed state is disabled and network errors are ignored', async () => {
    await withTempDir(async (dir) => {
      expect(await loadTelemetryState(dir)).toBeUndefined();
      const telemetry = new Telemetry(
        { enabled: true, installationId: '00000000-0000-4000-8000-000000000000' },
        async () => {
          throw new Error('offline');
        },
      );
      expect(() => telemetry.emit('session_started')).not.toThrow();
    });
  });
});
