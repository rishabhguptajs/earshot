import { describe, expect, test } from 'bun:test';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Agent } from '../src/agent.ts';
import {
  discoverExtensions,
  expandCommand,
  MAX_SKILL_CHARS,
  narrow,
  renderSkillIndex,
  type Skill,
} from '../src/skills/discover.ts';
import { BUILTIN_TOOLS } from '../src/tools/index.ts';
import { skillTool } from '../src/tools/skill.ts';
import type { ToolContext } from '../src/tools/types.ts';
import { outputText, withTempDir } from './helpers.ts';
import { scripted } from './scripted-model.ts';

async function writeSkill(dir: string, name: string, body: string, where = '.earshot/skills') {
  await mkdir(join(dir, where, name), { recursive: true });
  await writeFile(join(dir, where, name, 'SKILL.md'), body, 'utf8');
}

async function writeCommand(dir: string, name: string, body: string) {
  await mkdir(join(dir, '.earshot', 'commands'), { recursive: true });
  await writeFile(join(dir, '.earshot', 'commands', `${name}.md`), body, 'utf8');
}

/** Keeps the developer's own config directory out of every assertion. */
async function discover(dir: string, config = join(dir, 'config')) {
  const previous = process.env.EARSHOT_CONFIG_DIR;
  process.env.EARSHOT_CONFIG_DIR = config;
  try {
    return await discoverExtensions(dir);
  } finally {
    if (previous === undefined) delete process.env.EARSHOT_CONFIG_DIR;
    else process.env.EARSHOT_CONFIG_DIR = previous;
  }
}

function context(overrides: Partial<ToolContext> = {}): ToolContext {
  return { signal: new AbortController().signal, ...overrides } as unknown as ToolContext;
}

describe('discovering skills', () => {
  test('reads a skill directory and its description', async () => {
    await withTempDir(async (dir) => {
      await writeSkill(dir, 'release', '---\ndescription: cuts a release\n---\n\nStep one.');
      const { skills } = await discover(dir);

      expect(skills).toHaveLength(1);
      expect(skills[0]?.name).toBe('release');
      expect(skills[0]?.description).toBe('cuts a release');
      expect(skills[0]?.body).toBe('Step one.');
    });
  });

  test('names a skill after its file, not after what the file claims', async () => {
    await withTempDir(async (dir) => {
      // A skill that could name itself could take the name of one the user trusts.
      await writeSkill(dir, 'helper', '---\nname: release\ndescription: x\n---\n\nBody.');
      const { skills } = await discover(dir);
      expect(skills[0]?.name).toBe('helper');
    });
  });

  test('lets the user’s own skill win a name a project also uses', async () => {
    await withTempDir(async (dir) => {
      const config = join(dir, 'config');
      await mkdir(join(config, 'skills', 'deploy'), { recursive: true });
      await writeFile(join(config, 'skills', 'deploy', 'SKILL.md'), 'Mine.', 'utf8');
      await writeSkill(dir, 'deploy', 'Theirs.');

      const { skills, problems } = await discover(dir, config);
      expect(skills).toHaveLength(1);
      expect(skills[0]?.body).toBe('Mine.');
      expect(problems.join()).toContain('shadowed');
    });
  });

  test('caps a body that would crowd out the conversation', async () => {
    await withTempDir(async (dir) => {
      await writeSkill(dir, 'huge', 'x'.repeat(MAX_SKILL_CHARS * 2));
      const { skills } = await discover(dir);
      expect(skills[0]?.body.length).toBeLessThan(MAX_SKILL_CHARS + 100);
    });
  });

  test('says why an unusable skill was skipped', async () => {
    await withTempDir(async (dir) => {
      await mkdir(join(dir, '.earshot', 'skills', 'Bad Name'), { recursive: true });
      await writeFile(join(dir, '.earshot', 'skills', 'Bad Name', 'SKILL.md'), 'x', 'utf8');
      await mkdir(join(dir, '.earshot', 'skills', 'nofile'), { recursive: true });

      const { skills, problems } = await discover(dir);
      expect(skills).toHaveLength(0);
      expect(problems.join('\n')).toContain('usable name');
      expect(problems.join('\n')).toContain('has no SKILL.md');
    });
  });

  test('puts only names and descriptions in the prompt, never the bodies', () => {
    const skill: Skill = {
      name: 'release',
      description: 'cuts a release',
      scope: 'project',
      path: '/x',
      allowedTools: [],
      body: 'THE-SECRET-BODY',
    };
    const index = renderSkillIndex([skill]);

    expect(index).toContain('release: cuts a release');
    expect(index).not.toContain('THE-SECRET-BODY');
  });
});

describe('what a skill may do', () => {
  test('loading one is read-only, so a skill file cannot act by being read', () => {
    const tool = skillTool([]);
    expect(tool.readOnly).toBe(true);
  });

  test('allowed-tools narrows the session and never widens it', () => {
    // The session has no `bash`; a skill asking for it does not get it.
    expect(narrow(['read', 'edit'], ['read', 'bash'])).toEqual(['read']);
  });

  test('narrowing always leaves the agent able to ask', () => {
    expect(narrow(['read', 'edit', 'ask_user'], ['read'])).toContain('ask_user');
  });

  test('an empty allowed-tools changes nothing', () => {
    expect(narrow(['read', 'edit'], [])).toEqual(['read', 'edit']);
  });

  test('applies a skill’s narrowing when it is loaded', async () => {
    const skill: Skill = {
      name: 'review',
      description: 'reviews',
      scope: 'project',
      path: '/x',
      allowedTools: ['read', 'grep'],
      body: 'Read, do not write.',
    };
    let restricted: string[] | undefined;
    const tool = skillTool([skill]);
    const result = await tool.execute(
      tool.parse({ name: 'review' }),
      context({
        restrictTools: (names) => {
          restricted = names;
        },
      }),
    );

    expect(restricted).toEqual(['read', 'grep']);
    expect(outputText(result)).toContain('Read, do not write.');
    expect(outputText(result)).toContain('grants no permissions');
  });

  test('refuses a skill that does not exist rather than inventing one', () => {
    const tool = skillTool([]);
    expect(() => tool.parse({ name: 'nope' })).toThrow(/no skill named/);
  });
});

describe('user-defined slash commands', () => {
  test('are discovered with their description', async () => {
    await withTempDir(async (dir) => {
      await writeCommand(dir, 'ship', '---\ndescription: ships it\n---\n\nShip $ARGUMENTS.');
      const { commands } = await discover(dir);

      expect(commands[0]?.name).toBe('ship');
      expect(commands[0]?.description).toBe('ships it');
    });
  });

  test('expand their arguments, whole and positionally', () => {
    const command = {
      name: 'x',
      description: '',
      scope: 'project' as const,
      path: '/x',
      body: 'all: $ARGUMENTS; first: $1; second: $2',
    };
    expect(expandCommand(command, 'alpha beta')).toBe(
      'all: alpha beta; first: alpha; second: beta',
    );
  });

  test('leave no placeholder behind when an argument is missing', () => {
    const command = {
      name: 'x',
      description: '',
      scope: 'project' as const,
      path: '/x',
      body: 'run $1 then $2',
    };
    const expanded = expandCommand(command, 'only');
    expect(expanded).not.toContain('$');
    expect(expanded.trim()).toBe('run only then');
  });
});

describe('a skill that narrows the tool set', () => {
  test('removes tools from the next model call, and only until the turn ends', async () => {
    await withTempDir(async (dir) => {
      const skill: Skill = {
        name: 'review',
        description: 'reviews',
        scope: 'project',
        path: '/x',
        allowedTools: ['read', 'grep'],
        body: 'Read only.',
      };
      const model = scripted([
        { calls: [{ name: 'skill', input: { name: 'review' } }] },
        { text: 'reviewed' },
        { text: 'second turn' },
      ]);
      const agent = new Agent({
        registry: model.registry,
        model: model.model,
        cwd: dir,
        system: 'test system',
        mode: 'auto',
        rules: [],
        tools: [...BUILTIN_TOOLS, skillTool([skill]) as never],
      });

      const signal = new AbortController().signal;
      for await (const _ of agent.runTurn('review this', signal)) {
        // drained
      }
      const afterSkill = (model.requests[1]?.tools ?? []).map((tool) => tool.name);
      expect(afterSkill).toContain('read');
      expect(afterSkill).not.toContain('write');
      expect(afterSkill).not.toContain('bash');
      // The one tool a skill may never take away.
      expect(afterSkill).toContain('ask_user');

      for await (const _ of agent.runTurn('now something else', signal)) {
        // drained
      }
      const nextTurn = (model.requests.at(-1)?.tools ?? []).map((tool) => tool.name);
      expect(nextTurn).toContain('write');
    });
  });
});
