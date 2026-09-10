/**
 * The one list of built-in slash commands.
 *
 * Dispatch, the `/` menu and the table in docs/cli.md all read from here. Before
 * this existed the if-chain in app.tsx and the docs table were two hand-written
 * lists free to disagree, and a menu would have been a third: a command could be
 * dispatchable but undocumented, or documented and not dispatchable, with
 * nothing to notice either. The handler table in app.tsx is keyed by
 * `CommandName`, so a missing or extra handler is a compile error, and
 * packages/tui/test/commands.test.ts holds docs/cli.md to the same list.
 *
 * Nothing here knows about user-defined commands from `.earshot/commands`:
 * those are discovered at runtime and reach the menu from `session.commands`.
 */

export interface CommandVerb {
  readonly name: string;
  /** Argument shape as the user types it. */
  readonly args?: string;
  readonly summary: string;
}

export interface CommandSpec {
  readonly name: string;
  /** Other names that dispatch to the same handler. Not menu rows of their own. */
  readonly aliases?: readonly string[];
  /** Argument shape as the user types it, e.g. `<n>`; absent means none. */
  readonly args?: string;
  /**
   * One line, plain prose. This is the menu row and the docs cell, so it carries
   * no markdown: the menu renders into a terminal, not into a page.
   */
  readonly summary: string;
  /**
   * Refuses to run while a turn is in flight. Checked once by the dispatcher
   * rather than re-implemented per command, which is how three copies of the
   * same "finish or interrupt first" branch used to drift.
   */
  readonly idleOnly?: boolean;
  readonly verbs?: readonly CommandVerb[];
}

/**
 * Declared `as const` for the literal names, then re-exported as
 * `readonly CommandSpec[]`: without the widening, an entry that omits `args` or
 * `idleOnly` has no such property at all, and every reader has to narrow before
 * it can ask.
 */
const SPECS = [
  {
    name: 'help',
    summary: 'List the commands you can type',
  },
  {
    name: 'model',
    args: '[ref]',
    summary: 'Show the model in use, or switch to another for the rest of the session',
  },
  {
    name: 'reasoning',
    args: '[on|off|auto|none|low|medium|high|xhigh]',
    summary: 'Change reasoning effort, or force reasoning on or off for this model',
  },
  {
    name: 'thinking',
    args: '[show|hide]',
    summary: 'Show or hide streamed model reasoning',
  },
  {
    name: 'pool',
    args: '[setup|on|off]',
    summary: 'Show free-provider quota, or connect more providers',
  },
  {
    name: 'telemetry',
    args: '[enable|disable|status|reset]',
    summary: 'Manage opt-in anonymous telemetry',
  },
  {
    name: 'mode',
    args: '<plan|ask|accept-edits|auto|yolo>',
    summary: 'Change the permission mode',
  },
  {
    name: 'plan',
    args: '<task>',
    summary: 'Draft a plan in plan mode and write it to a file',
    idleOnly: true,
    verbs: [
      { name: 'edit', summary: 'Open the plan in $VISUAL/$EDITOR, or print its path' },
      { name: 'approve', summary: 'Pin the plan as the file now reads for the rest of the run' },
      { name: 'show', summary: 'Read the plan back' },
      { name: 'clear', summary: 'Unpin the plan' },
    ],
  },
  {
    name: 'compact',
    summary: 'Summarise the session so far and free up the context window',
    idleOnly: true,
  },
  {
    name: 'context',
    summary: 'Show what is in the context window and what compaction has dropped',
  },
  {
    name: 'cost',
    args: '[usd]',
    summary: 'Show what this session has spent, or set the budget ceiling; 0 removes it',
  },
  {
    name: 'todo',
    summary: "Show the agent's current todo list",
  },
  {
    name: 'permissions',
    summary: 'Show the permission mode and the rules in force',
  },
  {
    name: 'init',
    summary: 'Write an AGENTS.md describing this project',
    idleOnly: true,
  },
  {
    name: 'skills',
    summary: 'List discovered skills and user-defined commands',
  },
  {
    name: 'memory',
    summary: 'List remembered preferences, each with the sentence it came from',
    verbs: [{ name: 'forget', args: '<id>', summary: 'Delete one remembered preference' }],
  },
  {
    name: 'tree',
    summary: "List this session's prompts, numbered",
    idleOnly: true,
  },
  {
    name: 'sessions',
    summary: 'Browse and resume chats saved for this project',
    idleOnly: true,
  },
  {
    name: 'rewind',
    args: '<n>',
    summary: 'Go back to the state before prompt n; nothing is deleted',
    idleOnly: true,
  },
  {
    name: 'fork',
    args: '<n>',
    summary: 'Branch from prompt n into a new transcript',
    idleOnly: true,
  },
  {
    name: 'undo',
    summary: "Revert the last tool batch's file changes; again to step back further",
  },
  {
    name: 'exit',
    aliases: ['quit'],
    summary: 'Quit',
  },
] as const satisfies readonly CommandSpec[];

export const COMMANDS: readonly CommandSpec[] = SPECS;

export type CommandName = (typeof SPECS)[number]['name'];

/** The spec a typed name dispatches to, including via an alias. */
export function findCommand(name: string): CommandSpec | undefined {
  return COMMANDS.find(
    (command) =>
      command.name === name || (command.aliases as readonly string[] | undefined)?.includes(name),
  );
}

export interface CommandRow {
  /** As typed, e.g. `/plan approve`. */
  readonly command: string;
  readonly summary: string;
  readonly spec: CommandSpec;
}

/**
 * Every documented and menu-listable form, one row per verb.
 *
 * A verb is a row of its own because `/plan approve` does something a user would
 * never guess from a row that only says `/plan`, and a menu that hides it is a
 * menu that fails at the one job it has.
 */
export function commandRows(): CommandRow[] {
  const rows: CommandRow[] = [];
  for (const spec of COMMANDS) {
    rows.push({
      command: spec.args ? `/${spec.name} ${spec.args}` : `/${spec.name}`,
      summary: spec.summary,
      spec,
    });
    for (const verb of spec.verbs ?? []) {
      rows.push({
        command: `/${spec.name} ${verb.name}${verb.args ? ` ${verb.args}` : ''}`,
        summary: verb.summary,
        spec,
      });
    }
  }
  return rows;
}
