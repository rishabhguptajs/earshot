import { describe, expect, test } from 'bun:test';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { loadMemoryFiles, renderMemory } from '../src/context/agents-md.ts';
import { buildSystemPrompt } from '../src/context/system-prompt.ts';
import { withTempDir } from './helpers.ts';

/**
 * `loadMemoryFiles` also reads the user's real config directory. These tests
 * point EARSHOT_CONFIG_DIR at an empty temp directory so a developer's own
 * AGENTS.md does not change the result.
 */
async function inIsolation<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  return withTempDir(async (dir) => {
    const previous = process.env.EARSHOT_CONFIG_DIR;
    process.env.EARSHOT_CONFIG_DIR = join(dir, 'empty-config');
    try {
      return await fn(dir);
    } finally {
      if (previous === undefined) delete process.env.EARSHOT_CONFIG_DIR;
      else process.env.EARSHOT_CONFIG_DIR = previous;
    }
  });
}

describe('memory file loading', () => {
  test('files are ordered outermost first, so the nearest one is read last', async () => {
    await inIsolation(async (dir) => {
      const root = join(dir, 'repo');
      const nested = join(root, 'packages', 'app');
      await mkdir(join(root, '.git'), { recursive: true });
      await mkdir(nested, { recursive: true });
      await writeFile(join(root, 'AGENTS.md'), 'root rules');
      await writeFile(join(nested, 'AGENTS.md'), 'nested rules');

      const files = await loadMemoryFiles(nested);
      expect(files.map((file) => file.content)).toEqual(['root rules', 'nested rules']);
    });
  });

  test('the walk stops at the repository root', async () => {
    await inIsolation(async (dir) => {
      const root = join(dir, 'repo');
      await mkdir(join(root, '.git'), { recursive: true });
      await writeFile(join(dir, 'AGENTS.md'), 'outside the repo');
      await writeFile(join(root, 'AGENTS.md'), 'inside the repo');

      const files = await loadMemoryFiles(root);
      expect(files.map((file) => file.content)).toEqual(['inside the repo']);
    });
  });

  test('AGENTS.md wins over CLAUDE.md in the same directory rather than both loading', async () => {
    await inIsolation(async (dir) => {
      await mkdir(join(dir, '.git'), { recursive: true });
      await writeFile(join(dir, 'AGENTS.md'), 'agents');
      await writeFile(join(dir, 'CLAUDE.md'), 'claude');

      const files = await loadMemoryFiles(dir);
      expect(files.map((file) => file.content)).toEqual(['agents']);
    });
  });

  test('CLAUDE.md alone is still loaded', async () => {
    await inIsolation(async (dir) => {
      await mkdir(join(dir, '.git'), { recursive: true });
      await writeFile(join(dir, 'CLAUDE.md'), 'claude only');
      const files = await loadMemoryFiles(dir);
      expect(files.map((file) => file.content)).toEqual(['claude only']);
    });
  });

  test('an empty file is not loaded as an empty instruction', async () => {
    await inIsolation(async (dir) => {
      await mkdir(join(dir, '.git'), { recursive: true });
      await writeFile(join(dir, 'AGENTS.md'), '   \n\n');
      expect(await loadMemoryFiles(dir)).toEqual([]);
    });
  });

  test('rendering labels each file with its path', () => {
    const rendered = renderMemory(
      [{ path: '/repo/AGENTS.md', content: 'be brief', scope: 'project' }],
      '/repo',
    );
    expect(rendered).toContain('path="AGENTS.md"');
    expect(rendered).toContain('be brief');
  });
});

describe('the system prompt', () => {
  test('plan mode tells the model refusals are the design, not a bug to route around', async () => {
    const prompt = await buildSystemPrompt({
      cwd: '/repo',
      mode: 'plan',
      model: 'test/scripted',
      memory: '',
    });
    expect(prompt).toContain('<mode>plan</mode>');
    expect(prompt).toContain('Do not attempt to make changes by another route');
  });

  test('memory is included verbatim', async () => {
    const prompt = await buildSystemPrompt({
      cwd: '/repo',
      mode: 'ask',
      model: 'test/scripted',
      memory: '<memory path="AGENTS.md">never use tabs</memory>',
    });
    expect(prompt).toContain('never use tabs');
  });
});
