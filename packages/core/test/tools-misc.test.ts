import { describe, expect, test } from 'bun:test';
import { askUserTool } from '../src/tools/ask-user.ts';
import { bashTool } from '../src/tools/bash.ts';
import { exec, KILL_GRACE_MS } from '../src/tools/exec.ts';
import { matchesGlob } from '../src/tools/glob-match.ts';
import { resolveShell, ShellNotFoundError } from '../src/tools/shell.ts';
import { todoTool } from '../src/tools/todo.ts';
import { defineTool, ToolInputError } from '../src/tools/types.ts';
import { htmlToText, webFetchTool } from '../src/tools/web-fetch.ts';
import { outputText, run, testContext, withTempDir } from './helpers.ts';

describe('glob patterns', () => {
  test('* stops at a path separator', () => {
    expect(matchesGlob('src/*.ts', 'src/main.ts')).toBe(true);
    expect(matchesGlob('src/*.ts', 'src/deep/main.ts')).toBe(false);
  });

  test('** spans any number of segments, including none', () => {
    expect(matchesGlob('src/**/*.ts', 'src/main.ts')).toBe(true);
    expect(matchesGlob('src/**/*.ts', 'src/a/b/main.ts')).toBe(true);
  });

  test('a bare pattern is implicitly rooted at any depth', () => {
    expect(matchesGlob('*.ts', 'a/b/c.ts')).toBe(true);
    expect(matchesGlob('*.ts', 'c.ts')).toBe(true);
  });

  test('brace alternation matches either branch', () => {
    expect(matchesGlob('*.{ts,tsx}', 'src/a.tsx')).toBe(true);
    expect(matchesGlob('*.{ts,tsx}', 'src/a.js')).toBe(false);
  });

  test('a dot in the pattern is a literal dot', () => {
    expect(matchesGlob('a.ts', 'axts')).toBe(false);
  });
});

describe('shell resolution', () => {
  test('an explicit EARSHOT_BASH override wins', () => {
    const shell = resolveShell({ ...process.env, EARSHOT_BASH: '/opt/custom/bash' });
    // On Windows the override must exist on disk, so only the POSIX path is
    // asserted here; the Windows branch is covered by the failure test below.
    if (process.platform !== 'win32') expect(shell.file).toBe('/opt/custom/bash');
  });

  test('Windows without Git Bash fails with an install pointer, never a fallback shell', () => {
    if (process.platform !== 'win32') return;
    expect(() => resolveShell({ ProgramFiles: 'C:\\nonexistent' })).toThrow(ShellNotFoundError);
    expect(() => resolveShell({ ProgramFiles: 'C:\\nonexistent' })).toThrow(/Git for Windows/);
  });

  test('the resolved shell takes the command as a single -c argument', () => {
    if (process.platform === 'win32') return;
    expect(resolveShell({}).args).toEqual(['-c']);
  });
});

describe('bash', () => {
  test('a non-zero exit is reported as an error result rather than thrown', async () => {
    if (process.platform === 'win32') return;
    await withTempDir(async (dir) => {
      const result = await run(bashTool, { command: 'exit 3' }, testContext(dir));
      expect(result.isError).toBe(true);
      expect(outputText(result)).toContain('[exit 3]');
    });
  });

  test('the permission prompt shows the command verbatim', () => {
    const request = bashTool.permission?.(
      bashTool.parse({ command: 'rm -rf build' }),
      testContext('/'),
    );
    expect(request?.detail).toBe('rm -rf build');
    expect(request?.target).toBe('rm -rf build');
  });

  test('an empty command is rejected before it reaches a shell', () => {
    expect(() => bashTool.parse({ command: '   ' })).toThrow(ToolInputError);
  });
});

describe('a command that will not die', () => {
  test('returns soon after its timeout instead of waiting for what it started', async () => {
    const shell = resolveShell();
    const started = Date.now();
    // Ignores SIGTERM and holds the pipes open through a child of its own,
    // which is the shape that made a hook with a timeout wedge the turn: the
    // `close` event waits on the grandchild, however dead the child is.
    const result = await exec(shell.file, [...shell.args, "trap '' TERM; sleep 30"], {
      cwd: process.cwd(),
      timeoutMs: 200,
    });

    expect(result.timedOut).toBe(true);
    // Generous, because it is asserting "bounded" rather than a duration - the
    // failure it guards against was thirty seconds, or forever.
    expect(Date.now() - started).toBeLessThan(KILL_GRACE_MS + 4_000);
  }, 20_000);
});

describe('todo', () => {
  test('two in_progress items are rejected', () => {
    expect(() =>
      todoTool.parse({
        items: [
          { id: '1', text: 'a', status: 'in_progress' },
          { id: '2', text: 'b', status: 'in_progress' },
        ],
      }),
    ).toThrow(/only one item/);
  });

  test('the list replaces rather than appends', async () => {
    const ctx = testContext('/');
    await run(todoTool, { items: [{ id: '1', text: 'a', status: 'pending' }] }, ctx);
    await run(todoTool, { items: [{ id: '2', text: 'b', status: 'done' }] }, ctx);
    expect(ctx.todos.list()).toEqual([{ id: '2', text: 'b', status: 'done' }]);
  });
});

describe('ask_user', () => {
  test('returns the user answer as the tool output', async () => {
    const ctx = testContext('/');
    const result = await run(askUserTool, { question: 'Which database?' }, ctx);
    expect(ctx.asked).toEqual(['Which database?']);
    expect(outputText(result)).toBe('answered');
  });

  test('asking is never itself gated', () => {
    expect(askUserTool.readOnly).toBe(true);
    expect(askUserTool.permission).toBeUndefined();
  });
});

describe('web_fetch', () => {
  test('a non-http scheme is refused', () => {
    expect(() => webFetchTool.parse({ url: 'file:///etc/passwd' })).toThrow(/http and https/);
  });

  test('the permission target is the host, so a rule can allow one site', () => {
    const request = webFetchTool.permission?.(
      webFetchTool.parse({ url: 'https://example.com/a/b' }),
      testContext('/'),
    );
    expect(request?.target).toBe('example.com');
  });

  test('script and style contents are dropped from extracted text', () => {
    const html =
      '<html><style>.a{color:red}</style><body><p>Hello</p><script>evil()</script></body></html>';
    const extracted = htmlToText(html);
    expect(extracted).toContain('Hello');
    expect(extracted).not.toContain('evil');
    expect(extracted).not.toContain('color:red');
  });
});

describe('defineTool', () => {
  test('a mutating tool with no permission() fails at construction', () => {
    expect(() =>
      defineTool({
        name: 'sneaky',
        description: '',
        inputSchema: {},
        readOnly: false,
        parse: () => ({}),
        execute: async () => ({ output: { type: 'text', value: '' } }),
      }),
    ).toThrow(/declares no permission/);
  });
});
