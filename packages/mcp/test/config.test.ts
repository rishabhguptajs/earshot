import { describe, expect, test } from 'bun:test';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { loadMcpConfig } from '../src/config.ts';
import { withTempDir } from './helpers.ts';

async function project(dir: string, settings: unknown, file = 'settings.json'): Promise<void> {
  await mkdir(join(dir, '.earshot'), { recursive: true });
  await writeFile(join(dir, '.earshot', file), JSON.stringify(settings), 'utf8');
}

/** Points the global scope at an empty directory so the developer's own config never leaks in. */
async function load(dir: string) {
  const previous = process.env.EARSHOT_CONFIG_DIR;
  process.env.EARSHOT_CONFIG_DIR = join(dir, 'config');
  try {
    return await loadMcpConfig(dir);
  } finally {
    if (previous === undefined) delete process.env.EARSHOT_CONFIG_DIR;
    else process.env.EARSHOT_CONFIG_DIR = previous;
  }
}

describe('server configuration', () => {
  test('a server the project checked in is not started until the user trusts it', async () => {
    await withTempDir(async (dir) => {
      await project(dir, { mcpServers: { helper: { command: 'node', args: ['s.js'] } } });
      const before = await load(dir);
      expect(before.servers[0]?.enabled).toBe(false);

      await project(dir, { mcpTrust: ['helper'] }, 'settings.local.json');
      const after = await load(dir);
      expect(after.servers[0]?.enabled).toBe(true);
    });
  });

  test('a server the user defined locally starts without a trust entry', async () => {
    await withTempDir(async (dir) => {
      await project(dir, { mcpServers: { mine: { command: 'node' } } }, 'settings.local.json');
      const { servers } = await load(dir);
      expect(servers[0]?.enabled).toBe(true);
      expect(servers[0]?.scope).toBe('local');
    });
  });

  test('a local definition replaces the project’s server of the same name', async () => {
    await withTempDir(async (dir) => {
      await project(dir, { mcpServers: { github: { command: 'theirs' } } });
      await project(dir, { mcpServers: { github: { command: 'mine' } } }, 'settings.local.json');
      const { servers } = await load(dir);

      expect(servers).toHaveLength(1);
      expect(servers[0]?.transport).toMatchObject({ command: 'mine' });
      expect(servers[0]?.enabled).toBe(true);
    });
  });

  test('reads an http server, headers and all', async () => {
    await withTempDir(async (dir) => {
      await project(
        dir,
        { mcpServers: { api: { type: 'http', url: 'https://x.test/mcp', headers: { a: 'b' } } } },
        'settings.local.json',
      );
      const { servers } = await load(dir);
      expect(servers[0]?.transport).toEqual({
        type: 'http',
        url: 'https://x.test/mcp',
        headers: { a: 'b' },
      });
    });
  });

  test('refuses a server name that could impersonate another server’s tools', async () => {
    await withTempDir(async (dir) => {
      await project(dir, { mcpServers: { git__hub: { command: 'x' } } }, 'settings.local.json');
      const { servers, problems } = await load(dir);
      expect(servers).toHaveLength(0);
      expect(problems.join()).toContain('not a usable server name');
    });
  });

  test('says what is wrong rather than dropping a malformed entry silently', async () => {
    await withTempDir(async (dir) => {
      await project(
        dir,
        {
          mcpServers: {
            old: { type: 'sse', url: 'https://x.test/sse' },
            empty: {},
            bad: { type: 'http', url: 'not a url' },
          },
        },
        'settings.local.json',
      );
      const { servers, problems } = await load(dir);

      expect(servers).toHaveLength(0);
      expect(problems.join('\n')).toContain('sse transport is not supported');
      expect(problems.join('\n')).toContain('neither a "command" nor a "url"');
      expect(problems.join('\n')).toContain('is not an http(s) URL');
    });
  });

  test('reports invalid JSON instead of starting nothing without saying why', async () => {
    await withTempDir(async (dir) => {
      await mkdir(join(dir, '.earshot'), { recursive: true });
      await writeFile(join(dir, '.earshot', 'settings.json'), '{ not json', 'utf8');
      const { problems } = await load(dir);
      expect(problems.join()).toContain('not valid JSON');
    });
  });
});
