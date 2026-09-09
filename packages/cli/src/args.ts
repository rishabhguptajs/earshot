export interface ParsedArgs {
  command: string | undefined;
  flags: Record<string, string | boolean>;
  positionals: string[];
}

/** Minimal, dependency-free flag parsing: --key=value, --key value, --bool, -p. */
export function parseArgs(argv: string[]): ParsedArgs {
  const flags: Record<string, string | boolean> = {};
  const positionals: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    if (arg === '--') {
      positionals.push(...argv.slice(i + 1));
      break;
    }
    if (arg.startsWith('--')) {
      const eq = arg.indexOf('=');
      if (eq !== -1) {
        flags[arg.slice(2, eq)] = arg.slice(eq + 1);
      } else {
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith('-')) {
          flags[arg.slice(2)] = next;
          i++;
        } else {
          flags[arg.slice(2)] = true;
        }
      }
    } else if (arg.startsWith('-') && arg.length > 1) {
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('-')) {
        flags[arg.slice(1)] = next;
        i++;
      } else {
        flags[arg.slice(1)] = true;
      }
    } else {
      positionals.push(arg);
    }
  }

  const known = new Set([
    'auth',
    'mcp',
    'extensions',
    'config',
    'pool',
    'models',
    'acp',
    'doctor',
    'update',
    'sessions',
  ]);
  const command =
    positionals[0] !== undefined && known.has(positionals[0]) ? positionals[0] : undefined;
  return { command, flags, positionals: command ? positionals.slice(1) : positionals };
}
