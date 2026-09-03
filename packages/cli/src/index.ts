import { VERSION } from '@earshot/core';
import { parseArgs } from './args.ts';

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
  --version, -v                print the version
  --help, -h                   print this help
`;

export async function main(argv = process.argv.slice(2)): Promise<number> {
  const { command, flags } = parseArgs(argv);

  if (flags.version || flags.v) {
    process.stdout.write(`${VERSION}\n`);
    return 0;
  }
  if (flags.help || flags.h || (!command && argv.length === 0 && !process.stdin.isTTY)) {
    process.stdout.write(HELP);
    return 0;
  }

  if (command) {
    process.stderr.write(`earshot: "${command}" is not implemented yet\n`);
    return 1;
  }

  process.stdout.write(HELP);
  return 0;
}
