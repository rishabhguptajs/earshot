import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { Agent, type AgentEvent } from '../src/agent.ts';
import type { PromptChoice } from '../src/permissions/engine.ts';
import { ScopeContract, summariseDiff } from '../src/scope/index.ts';
import type { PermissionRequest } from '../src/tools/types.ts';
import { withTempDir } from './helpers.ts';
import { scripted } from './scripted-model.ts';

const cwd = '/project';

function write(path: string, diff: string): PermissionRequest {
  return {
    tool: 'Write',
    target: path,
    title: `write ${path}`,
    detail: diff,
    writes: [join(cwd, path)],
  };
}

function edit(added: string[], removed: string[] = []): string {
  return [
    '--- a/src/parser.ts',
    '+++ b/src/parser.ts',
    '@@ -1,1 +1,1 @@',
    ...removed.map((line) => `-${line}`),
    ...added.map((line) => `+${line}`),
  ].join('\n');
}

describe('the scope guard', () => {
  test('stays quiet when nothing has been declared', () => {
    const scope = new ScopeContract(cwd);
    expect(scope.check(write('anything.ts', edit(['x'])))).toBeUndefined();
  });

  test('a file inside the declared scope passes without asking', () => {
    const scope = new ScopeContract(cwd);
    scope.declare({ files: ['src/parser.ts'], intent: 'fix the parser' });
    expect(scope.check(write('src/parser.ts', edit(['x'])))).toBeUndefined();
  });

  test('a file nobody mentioned is reported with the declared list', () => {
    const scope = new ScopeContract(cwd);
    scope.declare({ files: ['src/parser.ts'], intent: 'fix the parser' });
    const concern = scope.check(write('src/renderer.ts', edit(['x'])));

    expect(concern?.kind).toBe('out-of-scope-file');
    expect(concern?.summary).toContain('src/parser.ts');
  });

  test('a glob in the declared scope covers the files it matches', () => {
    const scope = new ScopeContract(cwd);
    scope.declare({ files: ['src/**/*.ts'], intent: 'rename a symbol' });
    expect(scope.check(write('src/deep/nested.ts', edit(['x'])))).toBeUndefined();
  });

  test('touching the dependency manifest is reported even inside a broad scope', () => {
    const scope = new ScopeContract(cwd);
    scope.declare({ files: ['**'], intent: 'fix the parser' });
    expect(scope.check(write('package.json', edit(['  "left-pad": "1.0.0"'])))?.kind).toBe(
      'new-dependency',
    );
  });

  test('a command that installs a dependency is reported', () => {
    const scope = new ScopeContract(cwd);
    scope.declare({ files: ['src/parser.ts'], intent: 'fix the parser' });
    const concern = scope.check({
      tool: 'Bash',
      target: 'bun add left-pad',
      title: 'bun add left-pad',
      detail: 'bun add left-pad',
    });
    expect(concern?.kind).toBe('new-dependency');
  });

  test('a command that renames or deletes files is reported', () => {
    const scope = new ScopeContract(cwd);
    scope.declare({ files: ['src/parser.ts'], intent: 'fix the parser' });
    const concern = scope.check({
      tool: 'Bash',
      target: 'git mv src/parser.ts src/parse.ts',
      title: 'git mv',
      detail: 'git mv src/parser.ts src/parse.ts',
    });
    expect(concern?.kind).toBe('rename-or-delete');
  });

  test('a change that only moves whitespace around is reported as a formatting sweep', () => {
    const scope = new ScopeContract(cwd);
    scope.declare({ files: ['src/parser.ts'], intent: 'fix the parser' });
    const lines = Array.from({ length: 15 }, (_, i) => `const value${i} = ${i};`);
    const concern = scope.check(
      write(
        'src/parser.ts',
        edit(
          lines.map((line) => `    ${line}`),
          lines,
        ),
      ),
    );
    expect(concern?.kind).toBe('formatting-sweep');
  });

  test('a real change of the same size is not a formatting sweep', () => {
    const scope = new ScopeContract(cwd);
    scope.declare({ files: ['src/parser.ts'], intent: 'fix the parser' });
    const before = Array.from({ length: 15 }, (_, i) => `const value${i} = ${i};`);
    const after = before.map((line) => line.replace('const', 'let'));
    expect(scope.check(write('src/parser.ts', edit(after, before)))?.kind).not.toBe(
      'formatting-sweep',
    );
  });

  test('deleting tests is reported', () => {
    const scope = new ScopeContract(cwd);
    scope.declare({ files: ['test/parser.test.ts'], intent: 'fix the parser tests' });
    const concern = scope.check(
      write(
        'test/parser.test.ts',
        edit([], ["test('parses an empty file', () => {", '  expect(parse()).toEqual([]);', '});']),
      ),
    );
    expect(concern?.kind).toBe('test-removal');
  });

  test('a turn far larger than its own estimate is reported once it passes the floor', () => {
    const scope = new ScopeContract(cwd, { floorLines: 50, overrunFactor: 3 });
    scope.declare({ files: ['src/parser.ts'], intent: 'a small fix', estimatedLines: 10 });

    const small = write('src/parser.ts', edit(Array.from({ length: 20 }, (_, i) => `line ${i}`)));
    expect(scope.check(small)).toBeUndefined();
    scope.record(small);
    scope.record(small);

    const concern = scope.check(small);
    expect(concern?.kind).toBe('over-budget');
  });

  test('a large change nobody estimated is judged against the floor, not against zero', () => {
    const scope = new ScopeContract(cwd, { floorLines: 150 });
    scope.declare({ files: ['src/parser.ts'], intent: 'rewrite the parser' });
    const hundred = write(
      'src/parser.ts',
      edit(Array.from({ length: 100 }, (_, i) => `line ${i}`)),
    );
    expect(scope.check(hundred)).toBeUndefined();
  });

  test('the same concern is not raised twice after the user has accepted it', () => {
    const scope = new ScopeContract(cwd);
    scope.declare({ files: ['src/parser.ts'], intent: 'fix the parser' });
    const request = write('src/renderer.ts', edit(['x']));
    const concern = scope.check(request);

    scope.widen(concern as never, 'src/renderer.ts');
    expect(scope.check(request)).toBeUndefined();
  });
});

describe('reading a diff', () => {
  test('counts only the changed lines, not the context', () => {
    const summary = summariseDiff(
      ['--- a/x', '+++ b/x', '@@ -1,3 +1,3 @@', ' same', '-old', '+new'].join('\n'),
    );
    expect(summary.changed).toBe(2);
  });
});

describe('the loop enforces the contract', () => {
  async function run(choice: PromptChoice): Promise<AgentEvent[]> {
    return withTempDir(async (dir) => {
      const model = scripted([
        {
          calls: [
            {
              name: 'declare_scope',
              input: { files: ['wanted.txt'], intent: 'change the wanted file' },
            },
          ],
        },
        { calls: [{ name: 'write', input: { path: 'other.txt', content: 'sneaky\n' } }] },
        { text: 'done' },
      ]);
      const agent = new Agent({
        registry: model.registry,
        model: model.model,
        cwd: dir,
        system: '',
        mode: 'auto',
        rules: [],
        prompt: async () => choice,
      });

      const events: AgentEvent[] = [];
      for await (const event of agent.runTurn('edit wanted.txt', new AbortController().signal)) {
        events.push(event);
      }
      return events;
    });
  }

  test('an edit outside the declared files asks the user first', async () => {
    const events = await run({ kind: 'allow' });
    const concern = events.find((event) => event.type === 'scope_concern');

    expect(concern).toBeDefined();
    expect(concern?.type === 'scope_concern' && concern.concern.kind).toBe('out-of-scope-file');
  });

  test('declining leaves the file alone and tells the model why', async () => {
    const events = await run({ kind: 'deny' });
    const failed = events.find(
      (event) => event.type === 'tool_end' && event.toolName === 'write' && event.result.isError,
    );

    expect(failed).toBeDefined();
    expect(
      failed?.type === 'tool_end' &&
        (failed.result.output as { value: string }).value.includes('declared scope'),
    ).toBe(true);
  });
});
