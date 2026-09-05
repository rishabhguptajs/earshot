import { describe, expect, test } from 'bun:test';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { McpConnectError } from '../src/client.ts';
import type { ServerConfig } from '../src/config.ts';
import { McpManager } from '../src/manager.ts';
import { descriptor, FakeServer, toolContext, withTempDir } from './helpers.ts';

async function settings(dir: string, value: unknown, file = 'settings.local.json') {
  await mkdir(join(dir, '.earshot'), { recursive: true });
  await writeFile(join(dir, '.earshot', file), JSON.stringify(value), 'utf8');
}

async function start(dir: string, servers: Record<string, FakeServer | Error>) {
  const previous = process.env.EARSHOT_CONFIG_DIR;
  process.env.EARSHOT_CONFIG_DIR = join(dir, 'config');
  try {
    return await McpManager.start({
      cwd: dir,
      connect: async (config: ServerConfig) => {
        const entry = servers[config.name];
        if (entry instanceof Error) throw entry;
        if (!entry) throw new McpConnectError(config.name, 'not configured in this test');
        return entry;
      },
    });
  } finally {
    if (previous === undefined) delete process.env.EARSHOT_CONFIG_DIR;
    else process.env.EARSHOT_CONFIG_DIR = previous;
  }
}

describe('the manager', () => {
  test('keeps the working servers when one fails to start', async () => {
    await withTempDir(async (dir) => {
      await settings(dir, {
        mcpServers: { good: { command: 'a' }, broken: { command: 'b' } },
      });
      const manager = await start(dir, {
        good: new FakeServer('good', { tools: [descriptor('search')] }),
        broken: new McpConnectError('broken', 'spawn ENOENT'),
      });

      expect(manager.tools().map((tool) => tool.name)).toEqual(['good__search']);
      expect(manager.summary().join('\n')).toContain('spawn ENOENT');
      await manager.close();
    });
  });

  test('keeps the working servers when one cannot list its tools', async () => {
    await withTempDir(async (dir) => {
      await settings(dir, { mcpServers: { good: { command: 'a' }, rude: { command: 'b' } } });
      const manager = await start(dir, {
        good: new FakeServer('good', { tools: [descriptor('search')] }),
        rude: new FakeServer('rude', {
          listTools: () => Promise.reject(new Error('timed out after 30000ms')),
        }),
      });

      expect(manager.tools()).toHaveLength(1);
      expect(manager.summary().join('\n')).toContain('listing its tools failed');
      await manager.close();
    });
  });

  test('does not start a project server the user has not trusted, and says so', async () => {
    await withTempDir(async (dir) => {
      await settings(dir, { mcpServers: { helper: { command: 'a' } } }, 'settings.json');
      const server = new FakeServer('helper', { tools: [descriptor('search')] });
      const manager = await start(dir, { helper: server });

      expect(manager.tools()).toHaveLength(0);
      expect(manager.reports[0]?.status).toBe('untrusted');
      expect(manager.summary().join()).toContain('earshot mcp trust');
      await manager.close();
    });
  });

  test('namespaces two servers offering the same tool name', async () => {
    await withTempDir(async (dir) => {
      await settings(dir, { mcpServers: { a: { command: 'x' }, b: { command: 'y' } } });
      const manager = await start(dir, {
        a: new FakeServer('a', { tools: [descriptor('search')] }),
        b: new FakeServer('b', { tools: [descriptor('search')] }),
      });

      expect(
        manager
          .tools()
          .map((tool) => tool.name)
          .sort(),
      ).toEqual(['a__search', 'b__search']);
      await manager.close();
    });
  });

  test('routes a call to the server that offered the tool', async () => {
    await withTempDir(async (dir) => {
      await settings(dir, { mcpServers: { a: { command: 'x' }, b: { command: 'y' } } });
      const a = new FakeServer('a', { tools: [descriptor('search')] });
      const b = new FakeServer('b', { tools: [descriptor('search')] });
      const manager = await start(dir, { a, b });

      const tool = manager.tools().find((candidate) => candidate.name === 'b__search');
      await tool?.execute(tool.parse({ q: 'hello' }) as never, toolContext());

      expect(a.calls).toHaveLength(0);
      expect(b.calls).toEqual([{ tool: 'search', args: { q: 'hello' } }]);
      await manager.close();
    });
  });

  test('closes every server it started', async () => {
    await withTempDir(async (dir) => {
      await settings(dir, { mcpServers: { a: { command: 'x' } } });
      const a = new FakeServer('a', { tools: [descriptor('search')] });
      const manager = await start(dir, { a });
      await manager.close();
      expect(a.closed).toBe(true);
    });
  });
});
