import { VERSION } from '@earshot/core';
import { parseArgs } from './args.ts';
import { headlessCommand } from './commands/headless.ts';
import { modelsCommand } from './commands/models.ts';

const HELP = `earshot ${VERSION} - a terminal coding agent that actually listens

Usage
  earshot                      start the interactive TUI
  earshot -p "<prompt>"        headless: print the final response
  earshot auth <login|list>    manage provider credentials
  earshot models [--refresh]   list or refresh the model catalog
  earshot mcp <list|add>       manage MCP servers
  earshot doctor               diagnose the local setup

Flags
  --model <provider/model>     model for this session
  --permission-mode <mode>     plan | ask | accept-edits | auto | yolo
  --output-format <fmt>        text | json | stream-json  (with -p)
  --continue                   resume the most recent session here
  --resume [<path>]            resume a specific session transcript
  --api-key <key>              credentials for this run only
  --version, -v                print the version
  --help, -h                   print this help
`;

export async function main(argv = process.argv.slice(2)): Promise<number> {
  const args = parseArgs(argv);
  const { command, flags } = args;

  if (flags.version || flags.v) {
    process.stdout.write(`${VERSION}\n`);
    return 0;
  }
  if (flags.help || flags.h) {
    process.stdout.write(HELP);
    return 0;
  }

  const prompt = typeof flags.p === 'string' ? flags.p : undefined;
  if (prompt) return headlessCommand(prompt, args);

  if (command === 'models') return modelsCommand(args);
  if (command) {
    process.stderr.write(`earshot: "${command}" is not implemented yet\n`);
    return 1;
  }

  // The interactive TUI lands in M2; until then the bare command explains itself.
  process.stdout.write(HELP);
  return 0;
}
