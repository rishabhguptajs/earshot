import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { COMMANDS, commandRows, findCommand } from '../src/commands.ts';

/**
 * The registry against the documentation.
 *
 * Same shape as the headless output contract's test in
 * packages/cli/test/output.test.ts, and for the same reason: two hand-written
 * lists of the same thing drift, and the drift is only ever found by a user who
 * typed a command the table promised. Dispatch and the `/` menu both read the
 * registry, so pinning docs/cli.md to it closes the last free-running copy.
 */
const DOC = readFileSync(join(import.meta.dir, '../../../docs/cli.md'), 'utf8');

/**
 * The one documented row with no registry entry. User-defined commands are
 * discovered from `.earshot/commands/<name>.md` at runtime, so the registry
 * cannot name them and this row stands for all of them.
 */
const DYNAMIC_ROW = '/<name>';

function tableRows(): Array<{ command: string; effect: string }> {
  // Bounded at the next heading: the exit-code and environment tables further
  // down are also `| … | … |`, and an unbounded slice reads them as commands.
  const from = DOC.indexOf('## In-session commands');
  const to = DOC.indexOf('\n## ', from + 1);
  const section = DOC.slice(from, to === -1 ? undefined : to);
  const rows: Array<{ command: string; effect: string }> = [];
  for (const line of section.split('\n')) {
    const match = /^\|\s*`([^`]+)`\s*\|\s*(.+?)\s*\|$/.exec(line);
    if (!match?.[1] || !match[2]) continue;
    rows.push({ command: unescapePipes(match[1]), effect: plain(match[2]) });
  }
  return rows;
}

/** A `|` inside a table cell has to be escaped; the registry holds the real one. */
const unescapePipes = (text: string) => text.replaceAll('\\|', '|');

/** Docs may emphasise; the registry summary is what a terminal row can render. */
const plain = (text: string) => text.replaceAll('`', '').replaceAll('**', '');

describe('the command registry and docs/cli.md', () => {
  test('document exactly the same commands, in the same order', () => {
    const documented = tableRows()
      .map((row) => row.command)
      .filter((command) => command !== DYNAMIC_ROW);
    expect(documented).toEqual(commandRows().map((row) => row.command));
  });

  test('describe each command the same way', () => {
    const documented = new Map(tableRows().map((row) => [row.command, row.effect]));
    for (const row of commandRows()) {
      expect(documented.get(row.command)).toBe(row.summary);
    }
  });

  test('still document the user-defined command row, which the registry cannot know', () => {
    expect(tableRows().map((row) => row.command)).toContain(DYNAMIC_ROW);
  });
});

describe('the registry itself', () => {
  test('has no duplicate name or alias', () => {
    const names = COMMANDS.flatMap((command) => [command.name, ...(command.aliases ?? [])]);
    expect(new Set(names).size).toBe(names.length);
  });

  test('resolves aliases to the command they stand for', () => {
    expect(findCommand('quit')?.name).toBe('exit');
    expect(findCommand('exit')?.name).toBe('exit');
    expect(findCommand('nonsense')).toBeUndefined();
  });

  test('gives every command and verb a one-line summary', () => {
    for (const row of commandRows()) {
      expect(row.summary).not.toBe('');
      expect(row.summary).not.toContain('\n');
    }
  });
});
