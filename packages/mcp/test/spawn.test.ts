import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { connectServer } from '../src/client.ts';
import type { ServerConfig } from '../src/config.ts';

const FIXTURE = join(import.meta.dir, 'fixtures', 'server.mjs');

/**
 * The one test that spawns a real process and speaks the real protocol over a
 * real pipe. Everything else in this package uses an in-memory transport, which
 * cannot catch a mistake in how the process is launched - the environment it
 * gets, where its stderr goes, or whether it is killed on close.
 */
function config(overrides: Partial<ServerConfig> = {}): ServerConfig {
  return {
    name: 'fixture',
    scope: 'local',
    enabled: true,
    transport: {
      type: 'stdio',
      // `process.execPath` rather than a bare `node`: the runner may be bun,
      // and a hard-coded name is a test that passes on one machine.
      command: process.execPath,
      args: [FIXTURE],
      env: {},
    },
    timeoutMs: 20_000,
    ...overrides,
  };
}

const options = { cwd: process.cwd(), env: process.env };

describe('a real stdio server', () => {
  test('starts, lists its tools and answers a call', async () => {
    const client = await connectServer(config(), options);
    try {
      expect((await client.listTools()).map((tool) => tool.name).sort()).toEqual([
        'echo',
        'shout_env',
      ]);
      const result = await client.callTool(
        'echo',
        { value: 'hello' },
        new AbortController().signal,
      );
      expect(result).toEqual({ text: 'hello', isError: false });
    } finally {
      await client.close();
    }
  }, 30_000);

  test('does not hand the user’s environment to a server that did not ask', async () => {
    // A spawned server has no business reading an API key unless its config
    // named it. PATH gets through so the command resolves; a secret does not.
    const client = await connectServer(config(), {
      ...options,
      env: { ...process.env, EARSHOT_TEST_SECRET: 'do-not-leak' },
    });
    try {
      const leaked = await client.callTool(
        'shout_env',
        { name: 'EARSHOT_TEST_SECRET' },
        new AbortController().signal,
      );
      expect(leaked.text).toBe('absent');

      const path = await client.callTool(
        'shout_env',
        { name: 'PATH' },
        new AbortController().signal,
      );
      expect(path.text).toStartWith('present:');
    } finally {
      await client.close();
    }
  }, 30_000);

  test('passes through the variables its own config named', async () => {
    const client = await connectServer(
      config({
        transport: {
          type: 'stdio',
          command: process.execPath,
          args: [FIXTURE],
          env: { EARSHOT_TEST_SECRET: 'asked-for' },
        },
      }),
      options,
    );
    try {
      const result = await client.callTool(
        'shout_env',
        { name: 'EARSHOT_TEST_SECRET' },
        new AbortController().signal,
      );
      expect(result.text).toBe('present:asked-for');
    } finally {
      await client.close();
    }
  }, 30_000);

  test('keeps the server’s stderr out of the terminal and in its diagnostics', async () => {
    const client = await connectServer(config(), options);
    try {
      // Written by the fixture on startup; it must not have been inherited into
      // the process that is drawing the TUI.
      await Bun.sleep(200);
      expect(client.diagnostics()).toContain('fixture server ready');
    } finally {
      await client.close();
    }
  }, 30_000);

  test('reports a command that does not exist rather than hanging', async () => {
    expect(
      connectServer(
        config({
          transport: {
            type: 'stdio',
            command: 'earshot-no-such-binary',
            args: [],
            env: {},
          },
        }),
        options,
      ),
    ).rejects.toThrow(/failed to start/);
  }, 30_000);
});
