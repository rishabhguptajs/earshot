import { listSessions } from '@earshot/core';
import { runSessionPicker } from '@earshot/tui';
import type { ParsedArgs } from '../args.ts';
import { interactiveCommand } from './interactive.ts';

export async function sessionsCommand(args: ParsedArgs): Promise<number> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    process.stderr.write('earshot sessions needs an interactive terminal.\n');
    return 2;
  }
  const sessions = await listSessions(process.cwd());
  if (sessions.length === 0) {
    process.stdout.write('no saved chats for this project\n');
    return 0;
  }
  const path = await runSessionPicker(sessions);
  if (!path) return 0;
  return interactiveCommand({
    command: undefined,
    flags: { ...args.flags, resume: path },
    positionals: [],
  });
}
