import { describe, expect, test } from 'bun:test';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { unifiedDiff } from '../src/tools/diff.ts';
import { editTool, multiEditTool } from '../src/tools/edit.ts';
import { globTool } from '../src/tools/glob.ts';
import { grepTool } from '../src/tools/grep.ts';
import { lsTool } from '../src/tools/ls.ts';
import { readTool } from '../src/tools/read.ts';
import { ToolInputError } from '../src/tools/types.ts';
import { writeTool } from '../src/tools/write.ts';
import { outputText, run, testContext, withTempDir } from './helpers.ts';

describe('read', () => {
  test('numbers lines from 1 and reports the file length', async () => {
    await withTempDir(async (dir) => {
      await writeFile(join(dir, 'a.txt'), 'one\ntwo\nthree');
      const result = await run(readTool, { path: 'a.txt' }, testContext(dir));
      expect(outputText(result)).toContain('     1\tone');
      expect(outputText(result)).toContain('     3\tthree');
      expect(result.title).toContain('3 lines');
    });
  });

  test('an offset window keeps the real line numbers', async () => {
    await withTempDir(async (dir) => {
      await writeFile(join(dir, 'a.txt'), 'l1\nl2\nl3\nl4\nl5');
      const result = await run(readTool, { path: 'a.txt', offset: 3, limit: 2 }, testContext(dir));
      expect(outputText(result)).toContain('     3\tl3');
      expect(outputText(result)).toContain('     4\tl4');
      expect(outputText(result)).not.toContain('l5\n');
    });
  });

  test('reading a missing file reports the path rather than an ENOENT trace', async () => {
    await withTempDir(async (dir) => {
      const failure = run(readTool, { path: 'nope.txt' }, testContext(dir));
      await expect(failure).rejects.toThrow(/no such file: nope\.txt/);
    });
  });
});

describe('write', () => {
  test('creates parent directories and reports creation', async () => {
    await withTempDir(async (dir) => {
      const ctx = testContext(dir);
      const result = await run(writeTool, { path: 'deep/nested/a.txt', content: 'hi' }, ctx);
      expect(await readFile(join(dir, 'deep/nested/a.txt'), 'utf8')).toBe('hi');
      expect(outputText(result)).toContain('created');
    });
  });

  test('the permission prompt carries the full diff, not a summary', async () => {
    await withTempDir(async (dir) => {
      await writeFile(join(dir, 'a.txt'), 'before\n');
      const ctx = testContext(dir);
      const request = writeTool.permission?.(
        writeTool.parse({ path: 'a.txt', content: 'after\n' }),
        ctx,
      );
      expect(request?.detail).toContain('-before');
      expect(request?.detail).toContain('+after');
      expect(request?.writes).toEqual([join(dir, 'a.txt')]);
    });
  });

  test('a write marks the file read, so a follow-up edit is allowed', async () => {
    await withTempDir(async (dir) => {
      const ctx = testContext(dir);
      await run(writeTool, { path: 'a.txt', content: 'alpha\n' }, ctx);
      const result = await run(editTool, { path: 'a.txt', find: 'alpha', replace: 'beta' }, ctx);
      expect(await readFile(join(dir, 'a.txt'), 'utf8')).toBe('beta\n');
      expect(outputText(result)).toContain('+beta');
    });
  });
});

describe('edit', () => {
  test('refuses to edit a file this session has not read', async () => {
    await withTempDir(async (dir) => {
      await writeFile(join(dir, 'a.txt'), 'alpha\n');
      const failure = run(
        editTool,
        { path: 'a.txt', find: 'alpha', replace: 'beta' },
        testContext(dir),
      );
      await expect(failure).rejects.toThrow(/read a\.txt before editing it/);
    });
  });

  test('an ambiguous find is refused rather than resolved to the first match', async () => {
    await withTempDir(async (dir) => {
      await writeFile(join(dir, 'a.txt'), 'x = 1\ny = 2\nx = 1\n');
      const ctx = testContext(dir);
      await run(readTool, { path: 'a.txt' }, ctx);
      const failure = run(editTool, { path: 'a.txt', find: 'x = 1', replace: 'x = 9' }, ctx);
      await expect(failure).rejects.toThrow(/appears 2 times/);
      expect(await readFile(join(dir, 'a.txt'), 'utf8')).toBe('x = 1\ny = 2\nx = 1\n');
    });
  });

  test('replaceAll takes every occurrence', async () => {
    await withTempDir(async (dir) => {
      await writeFile(join(dir, 'a.txt'), 'x\nx\nx\n');
      const ctx = testContext(dir);
      await run(readTool, { path: 'a.txt' }, ctx);
      await run(editTool, { path: 'a.txt', find: 'x', replace: 'y', replaceAll: true }, ctx);
      expect(await readFile(join(dir, 'a.txt'), 'utf8')).toBe('y\ny\ny\n');
    });
  });

  test('a find that does not appear names the file and says why', async () => {
    await withTempDir(async (dir) => {
      await writeFile(join(dir, 'a.txt'), 'alpha\n');
      const ctx = testContext(dir);
      await run(readTool, { path: 'a.txt' }, ctx);
      const failure = run(editTool, { path: 'a.txt', find: 'gamma', replace: 'beta' }, ctx);
      await expect(failure).rejects.toThrow(/does not appear in a\.txt/);
    });
  });
});

describe('multi_edit', () => {
  test('applies edits in order, each against the result of the last', async () => {
    await withTempDir(async (dir) => {
      await writeFile(join(dir, 'a.txt'), 'one\n');
      const ctx = testContext(dir);
      await run(readTool, { path: 'a.txt' }, ctx);
      await run(
        multiEditTool,
        {
          path: 'a.txt',
          edits: [
            { find: 'one', replace: 'two' },
            { find: 'two', replace: 'three' },
          ],
        },
        ctx,
      );
      expect(await readFile(join(dir, 'a.txt'), 'utf8')).toBe('three\n');
    });
  });

  test('one failing edit leaves the file untouched', async () => {
    await withTempDir(async (dir) => {
      await writeFile(join(dir, 'a.txt'), 'one\n');
      const ctx = testContext(dir);
      await run(readTool, { path: 'a.txt' }, ctx);
      const failure = run(
        multiEditTool,
        {
          path: 'a.txt',
          edits: [
            { find: 'one', replace: 'two' },
            { find: 'nothing', replace: 'x' },
          ],
        },
        ctx,
      );
      await expect(failure).rejects.toThrow(ToolInputError);
      expect(await readFile(join(dir, 'a.txt'), 'utf8')).toBe('one\n');
    });
  });
});

describe('ls and glob', () => {
  test('ls sorts directories before files', async () => {
    await withTempDir(async (dir) => {
      await mkdir(join(dir, 'zdir'));
      await writeFile(join(dir, 'afile.txt'), '');
      const result = await run(lsTool, {}, testContext(dir));
      expect(outputText(result)).toBe('zdir/\nafile.txt');
    });
  });

  test('a pattern with no slash matches at any depth', async () => {
    await withTempDir(async (dir) => {
      await mkdir(join(dir, 'src'), { recursive: true });
      await writeFile(join(dir, 'src/main.ts'), '');
      await writeFile(join(dir, 'top.ts'), '');
      await writeFile(join(dir, 'skip.md'), '');
      const result = await run(globTool, { pattern: '*.ts' }, testContext(dir));
      expect(outputText(result)).toContain('src/main.ts');
      expect(outputText(result)).toContain('top.ts');
      expect(outputText(result)).not.toContain('skip.md');
    });
  });

  test('node_modules is never walked', async () => {
    await withTempDir(async (dir) => {
      await mkdir(join(dir, 'node_modules/pkg'), { recursive: true });
      await writeFile(join(dir, 'node_modules/pkg/index.ts'), '');
      await writeFile(join(dir, 'mine.ts'), '');
      const result = await run(globTool, { pattern: '**/*.ts' }, testContext(dir));
      expect(outputText(result)).not.toContain('node_modules');
      expect(outputText(result)).toContain('mine.ts');
    });
  });
});

describe('grep', () => {
  test('finds matches as path:line:text', async () => {
    await withTempDir(async (dir) => {
      await writeFile(join(dir, 'a.ts'), 'const x = 1;\nconst needle = 2;\n');
      const result = await run(grepTool, { pattern: 'needle' }, testContext(dir));
      expect(outputText(result)).toContain('a.ts:2:const needle = 2;');
    });
  });

  test('an invalid regular expression is a tool input error', async () => {
    await withTempDir(async (dir) => {
      const failure = run(grepTool, { pattern: '([' }, testContext(dir));
      await expect(failure).rejects.toThrow(ToolInputError);
    });
  });
});

describe('unifiedDiff', () => {
  test('an unchanged file produces no diff at all', () => {
    expect(unifiedDiff('a.txt', 'same\n', 'same\n')).toBe('');
  });

  test('a changed line appears as one removal and one addition', () => {
    const diff = unifiedDiff('a.txt', 'a\nb\nc\n', 'a\nB\nc\n');
    expect(diff).toContain('-b');
    expect(diff).toContain('+B');
    expect(diff).toContain(' a');
  });

  test('creating a file diffs against nothing', () => {
    const diff = unifiedDiff('new.txt', '', 'hello\n');
    expect(diff).toContain('+hello');
    expect(diff).not.toContain('-hello');
  });
});
