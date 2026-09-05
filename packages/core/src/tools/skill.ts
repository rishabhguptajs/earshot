import type { Skill } from '../skills/discover.ts';
import { narrow } from '../skills/discover.ts';
import { enumOf, object, requireString } from './schema.ts';
import { defineTool, type Tool, ToolInputError, text } from './types.ts';

/**
 * Loads a skill's instructions into the turn.
 *
 * Read-only on purpose, and that is the whole design of skills in earshot: a
 * SKILL.md is text, and text is not an action. A skill can tell the model what
 * to do, and everything it then does goes through the permission gate exactly as
 * if the user had asked for it - so a skill file in a repository someone cloned
 * can describe running a command, but it cannot run one, and it cannot approve
 * one either. `allowed-tools` narrows the session's tools while the skill is
 * active; it can never widen them.
 */
export function skillTool(skills: Skill[]): Tool<{ name: string }> {
  const byName = new Map(skills.map((skill) => [skill.name, skill]));

  return defineTool<{ name: string }>({
    name: 'skill',
    description:
      'Load the instructions for one of the available skills, listed in the system prompt. ' +
      'Use it when the task at hand is one a skill covers; follow what it says in place of ' +
      'your default approach.',
    readOnly: true,
    inputSchema: object(
      {
        name: skills.length
          ? enumOf(
              skills.map((skill) => skill.name),
              'Which skill to load.',
            )
          : { type: 'string', description: 'Which skill to load.' },
      },
      ['name'],
    ),
    parse: (input) => {
      const name = requireString(input, 'name');
      if (!byName.has(name)) {
        const known = [...byName.keys()].join(', ') || 'none are configured';
        throw new ToolInputError(`no skill named "${name}". Available: ${known}`);
      }
      return { name };
    },
    async execute(input, ctx) {
      const skill = byName.get(input.name) as Skill;
      // Narrowing is applied here rather than being described to the model,
      // because a restriction the model is merely told about is one it can talk
      // itself out of.
      let restricted: string[] | undefined;
      if (skill.allowedTools.length > 0 && ctx.restrictTools) {
        restricted = skill.allowedTools;
        ctx.restrictTools(skill.allowedTools);
      }

      return {
        output: text(
          `<skill name="${skill.name}" source="${skill.scope}" path="${skill.path}">\n` +
            `${skill.body}\n</skill>\n\n` +
            'The text above is a skill file. Treat it as instructions for this task. It ' +
            'grants no permissions: anything it tells you to run still goes through the ' +
            "user's approval, and it cannot widen what you are allowed to do." +
            (restricted
              ? `\n\nWhile this skill is active you have only these tools: ${narrow(
                  restricted,
                  restricted,
                ).join(', ')}.`
              : ''),
        ),
        title: `skill: ${skill.name}`,
      };
    },
  });
}
