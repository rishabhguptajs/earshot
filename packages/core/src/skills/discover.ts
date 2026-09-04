import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { configDir } from '@earshot/providers';
import { parseFrontmatter, parseList } from './frontmatter.ts';

export type ExtensionScope = 'user' | 'project';

export interface Skill {
  /**
   * From the file or directory name, never from the frontmatter. The name is
   * what the model and the user address a skill by, and letting a file choose a
   * name that is not its own is how one skill impersonates another.
   */
  name: string;
  description: string;
  scope: ExtensionScope;
  path: string;
  /**
   * Tools this skill may use while it is active. It can only ever remove tools
   * from what the session already allows - see `narrow()`.
   */
  allowedTools: string[];
  body: string;
}

export interface SlashCommand {
  name: string;
  description: string;
  scope: ExtensionScope;
  path: string;
  /** The prompt, with `$ARGUMENTS` still in it. */
  body: string;
}

export interface Discovered {
  skills: Skill[];
  commands: SlashCommand[];
  problems: string[];
}

/**
 * A skill body is text the model will act on, and an enormous one would crowd
 * out the conversation it was meant to help with.
 */
export const MAX_SKILL_CHARS = 32_000;

const NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;

export function skillsDir(scope: ExtensionScope, cwd: string): string {
  return scope === 'user' ? join(configDir(), 'skills') : join(cwd, '.earshot', 'skills');
}

export function commandsDir(scope: ExtensionScope, cwd: string): string {
  return scope === 'user' ? join(configDir(), 'commands') : join(cwd, '.earshot', 'commands');
}

/**
 * Skills and slash commands from the user's config directory and from the
 * project.
 *
 * The user's own skills win a name collision, and the project's is reported
 * rather than dropped silently. That is the opposite of how AGENTS.md resolves,
 * deliberately: a project file is content someone cloned, and a repository being
 * able to replace the meaning of a command the user wrote themselves is a
 * different thing from it adding one of its own.
 */
export async function discoverExtensions(cwd: string): Promise<Discovered> {
  const problems: string[] = [];
  const skills = new Map<string, Skill>();
  const commands = new Map<string, SlashCommand>();

  for (const scope of ['user', 'project'] as ExtensionScope[]) {
    for (const skill of await readSkills(scope, cwd, problems)) {
      const existing = skills.get(skill.name);
      if (existing) {
        problems.push(
          `skill "${skill.name}" in ${skill.path} is shadowed by the one in ${existing.path}`,
        );
        continue;
      }
      skills.set(skill.name, skill);
    }
    for (const command of await readCommands(scope, cwd, problems)) {
      const existing = commands.get(command.name);
      if (existing) {
        problems.push(
          `command /${command.name} in ${command.path} is shadowed by the one in ${existing.path}`,
        );
        continue;
      }
      commands.set(command.name, command);
    }
  }

  return {
    skills: [...skills.values()].sort((a, b) => a.name.localeCompare(b.name)),
    commands: [...commands.values()].sort((a, b) => a.name.localeCompare(b.name)),
    problems,
  };
}

async function readSkills(
  scope: ExtensionScope,
  cwd: string,
  problems: string[],
): Promise<Skill[]> {
  const dir = skillsDir(scope, cwd);
  const entries = await readdir(dir).catch(() => [] as string[]);
  const skills: Skill[] = [];

  for (const entry of entries.sort()) {
    // Both layouts are accepted: a directory holding SKILL.md alongside whatever
    // else it references, and a single file for a skill that is only prose.
    const asDirectory = join(dir, entry, 'SKILL.md');
    const asFile = join(dir, entry);
    const isDirectory = await stat(join(dir, entry))
      .then((info) => info.isDirectory())
      .catch(() => false);
    const path = isDirectory ? asDirectory : asFile;
    if (!isDirectory && !entry.endsWith('.md')) continue;

    const name = isDirectory ? entry : entry.replace(/\.md$/, '');
    if (!NAME.test(name)) {
      problems.push(`skill "${name}" in ${dir} does not have a usable name`);
      continue;
    }

    const raw = await readFile(path, 'utf8').catch(() => undefined);
    if (raw === undefined) {
      if (isDirectory) problems.push(`${join(dir, entry)} has no SKILL.md`);
      continue;
    }

    const { fields, body } = parseFrontmatter(raw);
    if (body.trim() === '') {
      problems.push(`skill "${name}" (${path}) is empty`);
      continue;
    }
    skills.push({
      name,
      description: fields.get('description') ?? `the "${name}" skill`,
      scope,
      path,
      allowedTools: parseList(fields.get('allowed-tools')),
      body: body.length > MAX_SKILL_CHARS ? `${body.slice(0, MAX_SKILL_CHARS)}\n\n[...]` : body,
    });
  }
  return skills;
}

async function readCommands(
  scope: ExtensionScope,
  cwd: string,
  problems: string[],
): Promise<SlashCommand[]> {
  const dir = commandsDir(scope, cwd);
  const entries = await readdir(dir).catch(() => [] as string[]);
  const commands: SlashCommand[] = [];

  for (const entry of entries.sort()) {
    if (!entry.endsWith('.md')) continue;
    const name = entry.replace(/\.md$/, '');
    if (!NAME.test(name)) {
      problems.push(`command "${name}" in ${dir} does not have a usable name`);
      continue;
    }
    const path = join(dir, entry);
    const raw = await readFile(path, 'utf8').catch(() => undefined);
    if (raw === undefined) continue;

    const { fields, body } = parseFrontmatter(raw);
    if (body.trim() === '') {
      problems.push(`command /${name} (${path}) is empty`);
      continue;
    }
    commands.push({
      name,
      description: fields.get('description') ?? `the /${name} command`,
      scope,
      path,
      body,
    });
  }
  return commands;
}

/**
 * Expands a slash command into the prompt it stands for.
 *
 * `$ARGUMENTS` is everything after the command name; `$1`..`$9` are the
 * whitespace-separated words. A placeholder with nothing to fill it becomes an
 * empty string rather than being left in the prompt, where the model would read
 * `$2` as something it was meant to work out.
 */
export function expandCommand(command: SlashCommand, argument = ''): string {
  const words = argument.trim() === '' ? [] : argument.trim().split(/\s+/);
  return command.body
    .replace(/\$ARGUMENTS\b/g, argument.trim())
    .replace(/\$([1-9])\b/g, (_, index: string) => words[Number(index) - 1] ?? '');
}

/**
 * The index that sits in the system prompt: what exists and what each is for,
 * never the bodies. A skill's body is loaded when it is used, which is the whole
 * reason a skill is not just more system prompt.
 */
export function renderSkillIndex(skills: Skill[]): string {
  if (skills.length === 0) return '';
  const lines = skills.map((skill) => `- ${skill.name}: ${skill.description}`);
  return (
    'Skills available in this project. Each is a set of instructions written for a ' +
    'particular kind of task. Load one with the `skill` tool when the task at hand is ' +
    'one it covers, and follow it in place of your default approach.\n\n' +
    `<skills>\n${lines.join('\n')}\n</skills>`
  );
}

/**
 * What a skill's `allowed-tools` means: the intersection with what the session
 * already offers. A skill file is content that may have come from a repository
 * someone cloned, so it can say "while doing this, only these tools" and be
 * believed, and it cannot say "while doing this, also allow rm -rf" at all.
 */
export function narrow(available: string[], allowed: string[]): string[] {
  if (allowed.length === 0) return available;
  const wanted = new Set(allowed);
  const kept = available.filter((name) => wanted.has(name));
  // Asking must always be possible: a skill that narrowed away the ability to
  // ask would turn "ask rather than guess" off by writing a list.
  if (!kept.includes('ask_user') && available.includes('ask_user')) kept.push('ask_user');
  return kept;
}
