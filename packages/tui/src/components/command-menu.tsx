import type { SlashCommand } from '@earshot/core';
import { Box, Text } from 'ink';
import { COMMANDS, type CommandSpec, commandRows } from '../commands.ts';
import { theme } from '../theme.ts';

/**
 * A summary longer than this is cut.
 *
 * The row is one line by construction: Ink wraps a `Text` that overruns the
 * terminal, and a wrapped row would push the rest of the menu - and the prompt
 * under it - down by an unpredictable number of lines on every keystroke.
 */
const SUMMARY_WIDTH = 58;

/** How many rows fit before the list starts hiding a small terminal's scrollback. */
const VISIBLE = 10;

export interface MenuEntry {
  /** What Tab completes into the input, without the argument placeholder. */
  readonly insert: string;
  /** What the row shows, argument placeholder included. */
  readonly label: string;
  readonly summary: string;
  /** User-defined commands are labelled by where they came from. */
  readonly scope?: string;
  readonly disabled?: boolean;
}

/**
 * The rows for a typed query, built from the registry and the session's
 * user-defined commands.
 *
 * A pure function rather than a hook so the app can index into the same list it
 * renders - a menu whose selection and display are computed separately is a
 * menu that eventually runs the row above the one that was highlighted.
 */
export function menuEntries(
  query: string,
  commands: readonly SlashCommand[],
  busy: boolean,
): MenuEntry[] {
  const entries: MenuEntry[] = [];

  for (const spec of ranked(COMMANDS, query)) {
    if (!matches(spec.name, query)) continue;
    const disabled = busy && spec.idleOnly === true;
    // Verbs only once the user has shown interest in that command: a bare `/`
    // listing every sub-verb buries the nine commands under fourteen rows.
    const expanded = query !== '' && spec.name.startsWith(query);
    for (const row of commandRows()) {
      if (row.spec.name !== spec.name) continue;
      const isBase = row.command === (spec.args ? `/${spec.name} ${spec.args}` : `/${spec.name}`);
      if (!isBase && !expanded) continue;
      entries.push({
        insert: insertFor(row.command, spec),
        label: row.command,
        summary: row.summary,
        ...(disabled ? { disabled: true } : {}),
      });
    }
  }

  for (const command of ranked(commands, query)) {
    if (!matches(command.name, query)) continue;
    entries.push({
      insert: `/${command.name}`,
      label: `/${command.name}`,
      summary: command.description,
      scope: command.scope,
    });
  }

  return entries;
}

/**
 * The argument placeholder is shown but never inserted: completing `/rewind <n>`
 * into the line would leave the user deleting the placeholder before they can
 * type the number.
 */
function insertFor(command: string, spec: CommandSpec): string {
  const withoutArgs = spec.args ? command.replace(` ${spec.args}`, '') : command;
  return withoutArgs.replace(/\s<[^>]*>$/, '');
}

/**
 * An undefined `color` prop is not the same as an absent one under
 * `exactOptionalPropertyTypes`, so the default row passes no colour at all.
 */
const clamp = (text: string) =>
  text.length <= SUMMARY_WIDTH ? text : `${text.slice(0, SUMMARY_WIDTH - 1)}…`;

function rowColor(entry: MenuEntry, active: boolean): { color?: string } {
  if (entry.disabled) return { color: theme.muted };
  if (active) return { color: theme.user };
  return {};
}

function matches(name: string, query: string): boolean {
  return query === '' || name.includes(query);
}

/**
 * Prefix matches first, so `/re` puts `/rewind` above `/tree` - the row the
 * user is most likely typing towards is the one Enter would run.
 * Otherwise the registry's own order is kept, which is the order docs/cli.md
 * documents.
 */
function ranked<T extends { readonly name: string }>(items: readonly T[], query: string): T[] {
  if (query === '') return [...items];
  return [
    ...items.filter((item) => item.name.startsWith(query)),
    ...items.filter((item) => !item.name.startsWith(query)),
  ];
}

export interface CommandMenuProps {
  entries: readonly MenuEntry[];
  selected: number;
}

/**
 * Lives in the live region only.
 *
 * Completed turns are in Ink's `Static` and are written to the terminal once;
 * anything that re-renders them would repaint real scrollback the user has
 * already scrolled past. This draws below them and disappears without touching
 * a row above it.
 */
export function CommandMenu({ entries, selected }: CommandMenuProps) {
  if (entries.length === 0) {
    return (
      <Box marginTop={1}>
        <Text color={theme.muted}>no command matches</Text>
      </Box>
    );
  }

  // The window follows the selection so arrowing past the eighth row scrolls
  // rather than moving a highlight nobody can see.
  const start = Math.min(
    Math.max(0, selected - VISIBLE + 1),
    Math.max(0, entries.length - VISIBLE),
  );
  const shown = entries.slice(start, start + VISIBLE);
  const hidden = entries.length - shown.length;

  return (
    <Box flexDirection="column" marginTop={1}>
      {shown.map((entry, index) => {
        const active = start + index === selected;
        return (
          <Box key={entry.label}>
            <Text color={active ? theme.user : theme.muted}>{active ? '› ' : '  '}</Text>
            <Text {...rowColor(entry, active)}>{entry.label.padEnd(34)}</Text>
            <Text color={theme.muted}>
              {clamp(
                `${entry.scope ? `[${entry.scope}] ` : ''}${entry.summary}${
                  entry.disabled ? ' (not while a turn is running)' : ''
                }`,
              )}
            </Text>
          </Box>
        );
      })}
      <Box>
        <Text color={theme.muted}>
          {hidden > 0 ? `  ${hidden} more · ` : '  '}↑↓ choose · tab complete · enter run · esc
          close
        </Text>
      </Box>
    </Box>
  );
}
