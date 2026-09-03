import { describe, expect, test } from 'bun:test';
import { parseArgs } from '../src/args.ts';

describe('parseArgs', () => {
  test('parses --key=value and --key value', () => {
    const { flags } = parseArgs(['--model=anthropic/claude-opus-5', '--permission-mode', 'plan']);
    expect(flags.model).toBe('anthropic/claude-opus-5');
    expect(flags['permission-mode']).toBe('plan');
  });

  test('treats a trailing flag as boolean', () => {
    expect(parseArgs(['--version']).flags.version).toBe(true);
    expect(parseArgs(['--json', '--verbose']).flags.json).toBe(true);
  });

  test('parses short flags with values', () => {
    expect(parseArgs(['-p', 'fix the build']).flags.p).toBe('fix the build');
  });

  test('recognises known subcommands only', () => {
    expect(parseArgs(['auth', 'login']).command).toBe('auth');
    expect(parseArgs(['auth', 'login']).positionals).toEqual(['login']);
    expect(parseArgs(['hello world']).command).toBeUndefined();
  });

  test('everything after -- is positional', () => {
    expect(parseArgs(['--', '--not-a-flag']).positionals).toEqual(['--not-a-flag']);
  });
});
