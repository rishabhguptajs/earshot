import { describe, expect, test } from 'bun:test';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Agent, type AgentEvent } from '../src/agent.ts';
import { detectTestCommand, runVerification } from '../src/verify/index.ts';
import { withTempDir } from './helpers.ts';
import { scripted } from './scripted-model.ts';

describe('finding the command that proves a change works', () => {
  test('a declared command in AGENTS.md wins over a package.json script', async () => {
    await withTempDir(async (dir) => {
      await writeFile(
        join(dir, 'AGENTS.md'),
        '## Commands\n\n- `bun test` - test suite\n- `bun run lint` - biome\n',
        'utf8',
      );
      await writeFile(join(dir, 'package.json'), JSON.stringify({ scripts: { test: 'jest' } }));

      expect(await detectTestCommand(dir)).toEqual({ command: 'bun test', source: 'AGENTS.md' });
    });
  });

  test('a settings file beats everything else', async () => {
    await withTempDir(async (dir) => {
      await mkdir(join(dir, '.earshot'), { recursive: true });
      await writeFile(join(dir, '.earshot', 'settings.json'), '{"verify":{"test":"cargo test"}}');
      await writeFile(join(dir, 'package.json'), JSON.stringify({ scripts: { test: 'jest' } }));

      expect((await detectTestCommand(dir))?.command).toBe('cargo test');
    });
  });

  test('a package.json test script is used when nothing is declared', async () => {
    await withTempDir(async (dir) => {
      await writeFile(join(dir, 'package.json'), JSON.stringify({ scripts: { test: 'vitest' } }));
      expect((await detectTestCommand(dir))?.command).toBe('npm test');
    });
  });

  test('the npm placeholder script is not treated as a test command', async () => {
    await withTempDir(async (dir) => {
      await writeFile(
        join(dir, 'package.json'),
        JSON.stringify({ scripts: { test: 'echo "Error: no test specified" && exit 1' } }),
      );
      expect(await detectTestCommand(dir)).toBeUndefined();
    });
  });

  test('a project with nothing to run reports nothing rather than guessing', async () => {
    await withTempDir(async (dir) => {
      expect(await detectTestCommand(dir)).toBeUndefined();
    });
  });
});

describe('running the command', () => {
  test('the output is returned exactly as printed, with the exit code', async () => {
    await withTempDir(async (dir) => {
      const result = await runVerification('echo one; echo two >&2; exit 3', 'test', { cwd: dir });

      expect(result.exitCode).toBe(3);
      expect(result.output).toContain('one');
      expect(result.output).toContain('two');
    });
  });
});

describe('the end-of-turn check', () => {
  async function run(
    turns: Parameters<typeof scripted>[0],
    dir: string,
    verify?: { command?: string; enabled?: boolean },
  ): Promise<{ events: AgentEvent[]; requests: ReturnType<typeof scripted>['requests'] }> {
    const model = scripted(turns);
    const agent = new Agent({
      registry: model.registry,
      model: model.model,
      cwd: dir,
      system: '',
      mode: 'auto',
      rules: [],
      ...(verify ? { verify } : {}),
    });
    const events: AgentEvent[] = [];
    for await (const event of agent.runTurn('do it', new AbortController().signal)) {
      events.push(event);
    }
    return { events, requests: model.requests };
  }

  test('a turn that changed a file runs the tests and hands over their output', async () => {
    await withTempDir(async (dir) => {
      const { events, requests } = await run(
        [{ calls: [{ name: 'write', input: { path: 'a.txt', content: 'x' } }] }, { text: 'done' }],
        dir,
        { command: 'echo THE_TESTS_RAN; exit 1' },
      );

      const verification = events.find((event) => event.type === 'verification');
      expect(verification?.type === 'verification' && verification.result.exitCode).toBe(1);

      // The model is shown the output, not a characterisation of it.
      const sent = JSON.stringify(requests.at(-1)?.messages ?? []);
      expect(sent).toContain('THE_TESTS_RAN');
      expect(sent).toContain('self-check');
    });
  });

  test('a turn that changed nothing is not interrupted by a check', async () => {
    await withTempDir(async (dir) => {
      const { events } = await run([{ text: 'just answering a question' }], dir, {
        command: 'echo should not run',
      });
      expect(events.some((event) => event.type === 'verification')).toBe(false);
    });
  });

  test('with no test command the model is told the change is unverified', async () => {
    await withTempDir(async (dir) => {
      const { requests } = await run(
        [{ calls: [{ name: 'write', input: { path: 'a.txt', content: 'x' } }] }, { text: 'done' }],
        dir,
      );
      expect(JSON.stringify(requests.at(-1)?.messages ?? [])).toContain('nothing was verified');
    });
  });

  test('the check is bounded, so a model that keeps editing still finishes', async () => {
    await withTempDir(async (dir) => {
      const write = (name: string) => ({
        calls: [{ name: 'write', input: { path: name, content: 'x' } }],
      });
      const { events } = await run(
        [
          write('a.txt'),
          { text: 'done' },
          write('b.txt'),
          { text: 'done again' },
          write('c.txt'),
          { text: 'and again' },
        ],
        dir,
        { command: 'exit 1' },
      );

      expect(events.filter((event) => event.type === 'verification')).toHaveLength(2);
      expect(events.at(-1)).toEqual({ type: 'turn_end', reason: 'stop' });
    });
  });
});
