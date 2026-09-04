import { describe, expect, test } from 'bun:test';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  deleteMemory,
  detectPreference,
  loadMemories,
  memoryDir,
  renderMemories,
  saveMemory,
} from '../src/memory/index.ts';
import { withTempDir } from './helpers.ts';

describe('spotting a preference in what the user typed', () => {
  test.each([
    ['use bun, not npm', 'use bun, not npm'],
    ["don't add comments to generated code", "don't add comments"],
    ['always run the tests before saying you are done', 'always run the tests'],
    ['no more emoji in commit messages', 'no more emoji'],
  ])('%p is offered as a memory', (prompt, expected) => {
    const candidate = detectPreference(prompt);
    expect(candidate?.text.toLowerCase()).toContain(expected.toLowerCase());
    expect(candidate?.source).toBe(prompt);
  });

  test('an ordinary request is not mistaken for a preference', () => {
    expect(detectPreference('add a retry to the fetch helper')).toBeUndefined();
  });

  test('an instruction scoped to this task is left alone', () => {
    // Remembering this one would apply it to every future session.
    expect(detectPreference("don't touch the tests in this PR")).toBeUndefined();
  });
});

describe('stored memories', () => {
  test('a saved memory records what the user said and when', async () => {
    await withTempDir(async (dir) => {
      const saved = await saveMemory(
        { text: 'Use bun, not npm.', source: 'use bun, not npm please', scope: 'project' },
        dir,
      );
      const raw = await readFile(saved.path, 'utf8');

      expect(raw).toContain('use bun, not npm please');
      expect(raw).toContain('created:');
      expect(saved.path.startsWith(join(dir, '.earshot', 'memories'))).toBe(true);
    });
  });

  test('a saved memory is loaded back with its provenance intact', async () => {
    await withTempDir(async (dir) => {
      await saveMemory(
        { text: 'Use bun, not npm.', source: 'use bun, not npm please', scope: 'project' },
        dir,
      );
      const [loaded] = await loadMemories(dir);

      expect(loaded?.text).toBe('Use bun, not npm.');
      expect(loaded?.source).toBe('use bun, not npm please');
      expect(loaded?.scope).toBe('project');
    });
  });

  test('deleting a memory removes it from what the model is told', async () => {
    await withTempDir(async (dir) => {
      const saved = await saveMemory(
        { text: 'Use bun, not npm.', source: 'use bun', scope: 'project' },
        dir,
      );
      expect(await deleteMemory(saved.id, dir)).toBe(true);
      expect(await loadMemories(dir)).toHaveLength(0);
    });
  });

  test('a hand-edited file with broken frontmatter is skipped, not fatal', async () => {
    await withTempDir(async (dir) => {
      const dirPath = memoryDir('project', dir);
      await mkdir(dirPath, { recursive: true });
      await writeFile(join(dirPath, 'broken.md'), 'no frontmatter here', 'utf8');
      await saveMemory({ text: 'Use bun.', source: 'use bun', scope: 'project' }, dir);

      const loaded = await loadMemories(dir);
      expect(loaded).toHaveLength(1);
      expect(loaded[0]?.text).toBe('Use bun.');
    });
  });

  test('the index names each memory so the agent can say which one it applied', () => {
    const rendered = renderMemories([
      {
        id: 'use-bun-not-npm',
        scope: 'project',
        text: 'Use bun, not npm.',
        source: 'use bun',
        created: '2026-01-01T00:00:00.000Z',
        path: '/x',
      },
    ]);
    expect(rendered).toContain('[use-bun-not-npm]');
    expect(rendered).toContain('Use bun, not npm.');
  });

  test('no memories means nothing is added to the prompt', () => {
    expect(renderMemories([])).toBe('');
  });
});
