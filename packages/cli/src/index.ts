import { VERSION } from '@earshot/core';
import { parseArgs } from './args.ts';
import { acpCommand } from './commands/acp.ts';
import { authCommand } from './commands/auth.ts';
import { doctorCommand } from './commands/doctor.ts';
import { extensionsCommand } from './commands/extensions.ts';
import { headlessCommand } from './commands/headless.ts';
import { interactiveCommand } from './commands/interactive.ts';
import { mcpCommand } from './commands/mcp.ts';
import { modelsCommand } from './commands/models.ts';
import { poolCommand } from './commands/pool.ts';
import { sessionsCommand } from './commands/sessions.ts';
import { telemetryCommand } from './commands/telemetry.ts';
import { updateCommand } from './commands/update.ts';

const HELP = `earshot ${VERSION} - a terminal coding agent that actually listens

Usage
  earshot                      start the interactive TUI
  earshot -p "<prompt>"        headless: print the final response
  earshot auth <cmd>           login, list or logout provider credentials
  earshot models [--refresh]   list or refresh the model catalog
  earshot mcp <cmd>            list, trust or untrust MCP servers
  earshot extensions <cmd>     list, trust or untrust in-process extensions
  earshot acp                  serve editor clients over ACP v1 on stdio
  earshot doctor               diagnose the local setup
  earshot update [--check]     update earshot to the latest release
  earshot sessions             browse and resume saved chats for this project
  earshot telemetry <cmd>      manage opt-in anonymous telemetry

Flags
  --model <provider/model>     model for this session
  --permission-mode <mode>     plan | ask | accept-edits | auto | yolo
  --output-format <fmt>        text | json | stream-json | json@v1  (with -p)
  --continue                   resume the most recent session here
  --resume [<path>]            resume a specific session transcript
  --api-key <key>              credentials for this run only
  --image <path|https-url>     attach one PNG, JPEG, GIF or WebP image
  --max-cost <usd>             stop and ask before spending past this
  --curiosity <level>          low, normal or high: how readily it asks
  --reasoning-effort <level>   auto | none | low | medium | high | xhigh
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
  if (command === 'mcp') return mcpCommand(args);
  if (command === 'extensions') return extensionsCommand(args);
  if (command === 'auth') return authCommand(args);
  if (command === 'pool') return poolCommand(args);
  if (command === 'doctor') return doctorCommand(args);
  if (command === 'update') return updateCommand(args);
  if (command === 'sessions') return sessionsCommand(args);
  if (command === 'acp') return acpCommand(args);
  if (command === 'telemetry') return telemetryCommand(args);
  if (command) {
    process.stderr.write(`earshot: "${command}" is not implemented yet\n`);
    return 1;
  }

  return interactiveCommand(args);
}
