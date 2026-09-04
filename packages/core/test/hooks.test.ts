import { describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Agent, type AgentEvent } from '../src/agent.ts';
import { type HookDefinition, loadHooks } from '../src/hooks/config.ts';
import { matches, runHooks } from '../src/hooks/run.ts';
import { HookRunner } from '../src/hooks/runner.ts';
import { withTempDir } from './helpers.ts';
import { type ScriptedTurn, scripted } from './scripted-model.ts';

const signal = () => new AbortController().signal;

/** A hook is a shell command; these are the smallest ones that do each thing. */
function hook(command: string, overrides: Partial<HookDefinition> = {}): HookDefinition {
  return {
    event: 'PreToolUse',
    command,
    timeoutMs: 5_000,
    scope: 'project',
    ...overrides,
  };
}

function run(hooks: HookDefinition[], cwd: string) {
  return runHooks(
    hooks,
    { session_id: 's', cwd, hook_event_name: 'PreToolUse', tool_name: 'bash' },
    { cwd, env: process.env },
  );
}

async function settings(dir: string, value: unknown, file = 'settings.json') {
  await mkdir(join(dir, '.earshot'), { recursive: true });
  await writeFile(join(dir, '.earshot', file), JSON.stringify(value), 'utf8');
}

describe('what a hook can decide', () => {
  test('exit 2 blocks the call, and its stderr is the reason', async () => {
    await withTempDir(async (dir) => {
      const outcome = await run([hook('echo "not on my watch" >&2; exit 2')], dir);
      expect(outcome.decision).toBe('deny');
      expect(outcome.reason).toContain('not on my watch');
    });
  });

  test('a JSON block decision denies with its reason', async () => {
    await withTempDir(async (dir) => {
      const outcome = await run(
        [hook(`echo '{"decision":"block","reason":"touching prod"}'`)],
        dir,
      );
      expect(outcome.decision).toBe('deny');
      expect(outcome.reason).toBe('touching prod');
    });
  });

  test('can downgrade an allow to a prompt', async () => {
    await withTempDir(async (dir) => {
      const outcome = await run(
        [
          hook(
            `echo '{"hookSpecificOutput":{"permissionDecision":"ask","permissionDecisionReason":"check first"}}'`,
          ),
        ],
        dir,
      );
      expect(outcome.decision).toBe('ask');
      expect(outcome.reason).toBe('check first');
    });
  });

  test('cannot grant one, and is told so rather than obeyed', async () => {
    await withTempDir(async (dir) => {
      // A hook command lives in a settings file a repository can ship. One that
      // could approve would be that repository granting itself permissions.
      const outcome = await run([hook(`echo '{"decision":"approve"}'`)], dir);

      expect(outcome.decision).toBeUndefined();
      expect(outcome.problems.join()).toContain('never grant');
    });
  });

  test('a deny anywhere beats an approve elsewhere', async () => {
    await withTempDir(async (dir) => {
      const outcome = await run([hook(`echo '{"decision":"approve"}'`), hook('exit 2')], dir);
      expect(outcome.decision).toBe('deny');
    });
  });
});

describe('a hook that misbehaves', () => {
  test('blocks nothing when it times out, and says it was killed', async () => {
    await withTempDir(async (dir) => {
      const outcome = await run([hook('sleep 10', { timeoutMs: 150 })], dir);
      expect(outcome.decision).toBeUndefined();
      expect(outcome.problems.join()).toContain('timed out');
    });
  });

  test('blocks nothing when it exits non-zero for any other reason', async () => {
    await withTempDir(async (dir) => {
      const outcome = await run([hook('echo broken >&2; exit 1')], dir);
      expect(outcome.decision).toBeUndefined();
      expect(outcome.problems.join()).toContain('exited 1');
    });
  });

  test('has unparseable output treated as a note, not as a decision', async () => {
    await withTempDir(async (dir) => {
      const outcome = await run([hook('echo "{ this is not json"')], dir);
      expect(outcome.decision).toBeUndefined();
      expect(outcome.context.join()).toContain('not json');
    });
  });

  test('cannot flood the context window', async () => {
    await withTempDir(async (dir) => {
      const outcome = await run([hook(`head -c 400000 /dev/zero | tr '\\0' 'x'`)], dir);
      expect(outcome.context.join('').length).toBeLessThan(20_000);
    });
  });
});

describe('matching', () => {
  test('an absent matcher fires on every tool', () => {
    expect(matches(hook('x'), 'bash')).toBe(true);
  });

  test('a matcher is anchored, so Edit does not fire on multi_edit', () => {
    expect(matches(hook('x', { matcher: 'edit' }), 'multi_edit')).toBe(false);
    expect(matches(hook('x', { matcher: 'edit' }), 'edit')).toBe(true);
  });

  test('alternatives match either tool', () => {
    expect(matches(hook('x', { matcher: 'edit|write' }), 'write')).toBe(true);
  });

  test('a matcher that is not a regex matches only that literal name', () => {
    expect(matches(hook('x', { matcher: 'a[' }), 'a[')).toBe(true);
    expect(matches(hook('x', { matcher: 'a[' }), 'bash')).toBe(false);
  });
});

describe('hook configuration', () => {
  test('is read from every scope rather than overridden by the narrowest', async () => {
    await withTempDir(async (dir) => {
      await settings(dir, {
        hooks: { PreToolUse: [{ matcher: 'bash', hooks: [{ type: 'command', command: 'a' }] }] },
      });
      await settings(
        dir,
        { hooks: { PostToolUse: [{ hooks: [{ type: 'command', command: 'b' }] }] } },
        'settings.local.json',
      );
      const previous = process.env.EARSHOT_CONFIG_DIR;
      process.env.EARSHOT_CONFIG_DIR = join(dir, 'config');
      const { hooks } = await loadHooks(dir);
      if (previous === undefined) delete process.env.EARSHOT_CONFIG_DIR;
      else process.env.EARSHOT_CONFIG_DIR = previous;

      expect(hooks).toHaveLength(2);
      expect(hooks.map((entry) => entry.event).sort()).toEqual(['PostToolUse', 'PreToolUse']);
    });
  });

  test('reads Claude Code’s timeout in seconds, not milliseconds', async () => {
    await withTempDir(async (dir) => {
      await settings(dir, {
        hooks: { Stop: [{ hooks: [{ type: 'command', command: 'a', timeout: 5 }] }] },
      });
      process.env.EARSHOT_CONFIG_DIR = join(dir, 'config');
      const { hooks } = await loadHooks(dir);
      delete process.env.EARSHOT_CONFIG_DIR;
      expect(hooks[0]?.timeoutMs).toBe(5_000);
    });
  });

  test('says when a hook is attached to an event that will never fire', async () => {
    await withTempDir(async (dir) => {
      await settings(dir, {
        hooks: { PreCompact: [{ hooks: [{ type: 'command', command: 'a' }] }] },
      });
      process.env.EARSHOT_CONFIG_DIR = join(dir, 'config');
      const { hooks, problems } = await loadHooks(dir);
      delete process.env.EARSHOT_CONFIG_DIR;

      expect(hooks).toHaveLength(0);
      expect(problems.join()).toContain('never fire');
    });
  });
});

async function collect(generator: AsyncGenerator<AgentEvent>): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of generator) events.push(event);
  return events;
}

function agentWith(turns: ScriptedTurn[], cwd: string, hooks: HookDefinition[]) {
  const model = scripted(turns);
  const agent = new Agent({
    registry: model.registry,
    model: model.model,
    cwd,
    system: 'test system',
    mode: 'auto',
    rules: [],
    hooks: new HookRunner(hooks, { cwd, env: process.env, sessionId: 'test' }),
  });
  return { agent, requests: model.requests };
}

describe('hooks in the loop', () => {
  test('a PreToolUse hook stops the tool and tells the model why', async () => {
    await withTempDir(async (dir) => {
      const { agent } = agentWith(
        [{ calls: [{ name: 'write', input: { path: 'a.txt', content: 'x' } }] }, { text: 'ok' }],
        dir,
        [hook('echo "no writes today" >&2; exit 2', { matcher: 'write' })],
      );
      const events = await collect(agent.runTurn('write a file', signal()));

      const ended = events.find((event) => event.type === 'tool_end');
      expect(ended?.type === 'tool_end' && ended.result.isError).toBe(true);
      expect(existsSync(join(dir, 'a.txt'))).toBe(false);
      expect(events.some((event) => event.type === 'hook' && event.blocked)).toBe(true);
    });
  });

  test('a UserPromptSubmit hook can stop the prompt reaching the model at all', async () => {
    await withTempDir(async (dir) => {
      const { agent, requests } = agentWith([{ text: 'should not run' }], dir, [
        hook('exit 2', { event: 'UserPromptSubmit' }),
      ]);
      await collect(agent.runTurn('do something', signal()));

      expect(requests).toHaveLength(0);
      expect(agent.history).toHaveLength(0);
    });
  });

  test('a UserPromptSubmit hook can add context to the prompt', async () => {
    await withTempDir(async (dir) => {
      const { agent, requests } = agentWith([{ text: 'ok' }], dir, [
        hook('echo "the branch is release/1.2"', { event: 'UserPromptSubmit' }),
      ]);
      await collect(agent.runTurn('what branch am I on', signal()));

      const first = requests[0]?.messages[0];
      const part = first?.content[0];
      expect(part?.type === 'text' && part.text).toContain('release/1.2');
    });
  });

  test('a PostToolUse hook adds to a result rather than replacing it', async () => {
    await withTempDir(async (dir) => {
      await writeFile(join(dir, 'a.txt'), 'the real contents\n');
      const { agent, requests } = agentWith(
        [{ calls: [{ name: 'read', input: { path: 'a.txt' } }] }, { text: 'ok' }],
        dir,
        [hook('echo "a linter also ran"', { event: 'PostToolUse' })],
      );
      await collect(agent.runTurn('read it', signal()));

      const toolMessage = requests[1]?.messages.find((message) => message.role === 'tool');
      const part = toolMessage?.content[0];
      const value =
        part?.type === 'tool_result' && part.output.type === 'text' ? part.output.value : '';
      expect(value).toContain('the real contents');
      expect(value).toContain('a linter also ran');
    });
  });

  test('a Stop hook can ask for one more model call, but not for an endless run', async () => {
    await withTempDir(async (dir) => {
      const { agent, requests } = agentWith(
        [{ text: 'first' }, { text: 'second' }, { text: 'third' }],
        dir,
        [hook('echo "keep going" >&2; exit 2', { event: 'Stop' })],
      );
      await collect(agent.runTurn('do it', signal()));

      // Blocked once, honoured once: a hook that could block every stop would
      // keep the agent running and spending with no way in.
      expect(requests).toHaveLength(2);
    });
  });
});
