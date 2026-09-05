import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { LOCAL_SETTINGS, loadMcpConfig, TRUST_NOTE } from '@earshot/mcp';
import type { ParsedArgs } from '../args.ts';

/**
 * `earshot mcp list|trust|untrust`.
 *
 * `list` deliberately does not start anything: seeing what is configured should
 * not be the thing that runs it.
 */
export async function mcpCommand(args: ParsedArgs): Promise<number> {
  const [action = 'list', name] = args.positionals;
  const cwd = process.cwd();

  if (action === 'list') return list(cwd);
  if (action === 'trust' || action === 'untrust') {
    if (!name) {
      process.stderr.write(`usage: earshot mcp ${action} <server>\n`);
      return 2;
    }
    return setTrust(cwd, name, action === 'trust');
  }

  process.stderr.write(`earshot mcp: unknown action "${action}"\n`);
  return 2;
}

async function list(cwd: string): Promise<number> {
  const { servers, problems } = await loadMcpConfig(cwd);
  for (const problem of problems) process.stderr.write(`warning: ${problem}\n`);

  if (servers.length === 0) {
    process.stdout.write(
      'no mcp servers configured\n\n' +
        `add one under "mcpServers" in ${join('.earshot', 'settings.local.json')}\n`,
    );
    return 0;
  }

  for (const server of servers) {
    const where =
      server.transport.type === 'stdio'
        ? [server.transport.command, ...server.transport.args].join(' ')
        : server.transport.url;
    const state = server.enabled ? '' : `  (not started: ${TRUST_NOTE})`;
    process.stdout.write(`${server.name}  [${server.scope}]  ${where}${state}\n`);
  }
  return 0;
}

/**
 * Trust is recorded in local settings, which are not committed. Writing it to
 * project settings would let a repository trust itself in the next clone.
 */
async function setTrust(cwd: string, name: string, trust: boolean): Promise<number> {
  const { servers } = await loadMcpConfig(cwd);
  if (!servers.some((server) => server.name === name)) {
    process.stderr.write(`no mcp server named "${name}" is configured\n`);
    return 2;
  }

  const path = join(cwd, LOCAL_SETTINGS);
  const raw = await readFile(path, 'utf8').catch(() => '{}');
  let settings: { mcpTrust?: string[] };
  try {
    settings = JSON.parse(raw) as { mcpTrust?: string[] };
  } catch (error) {
    process.stderr.write(`${path} is not valid JSON: ${(error as Error).message}\n`);
    return 2;
  }

  const current = new Set(settings.mcpTrust ?? []);
  if (trust) current.add(name);
  else current.delete(name);

  await mkdir(dirname(path), { recursive: true });
  await writeFile(
    path,
    `${JSON.stringify({ ...settings, mcpTrust: [...current].sort() }, null, 2)}\n`,
    'utf8',
  );
  process.stdout.write(`${trust ? 'trusted' : 'no longer trusting'} "${name}" (${path})\n`);
  return 0;
}
