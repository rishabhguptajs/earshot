import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { LOCAL_SETTINGS } from '@earshot/mcp';
import { configDir } from '@earshot/providers';
import type { ParsedArgs } from '../args.ts';
import {
  EXTENSION_TRUST_NOTE,
  loadExtensions,
  PROJECT_EXTENSIONS,
  trustedExtensions,
} from '../extensions/index.ts';

/**
 * `earshot extensions list|trust|untrust`.
 *
 * `list` names what is there without importing anything untrusted: an extension
 * runs the moment it is imported, so listing must not be the thing that runs it.
 */
export async function extensionsCommand(args: ParsedArgs): Promise<number> {
  const [action = 'list', name] = args.positionals;
  const cwd = process.cwd();

  if (action === 'list') return list(cwd);
  if (action === 'trust' || action === 'untrust') {
    if (!name) {
      process.stderr.write(`usage: earshot extensions ${action} <name>\n`);
      return 2;
    }
    return setTrust(cwd, name, action === 'trust');
  }

  process.stderr.write(`earshot extensions: unknown action "${action}"\n`);
  return 2;
}

async function list(cwd: string): Promise<number> {
  const { reports } = await loadExtensions(cwd, await trustedExtensions(cwd));
  if (reports.length === 0) {
    process.stdout.write(
      'no extensions found\n\n' +
        `add a module to ${PROJECT_EXTENSIONS} for this project, ` +
        `or to ${join(configDir(), 'extensions')} for every project\n`,
    );
    return 0;
  }

  for (const report of reports) {
    const state =
      report.status === 'ready'
        ? `${report.toolCount} tool${report.toolCount === 1 ? '' : 's'}`
        : `${report.status}: ${report.detail ?? EXTENSION_TRUST_NOTE}`;
    process.stdout.write(`${report.name}  [${report.scope}]  ${state}\n`);
  }
  return 0;
}

/** Recorded in local settings, which are not committed: see `earshot mcp trust`. */
async function setTrust(cwd: string, name: string, trust: boolean): Promise<number> {
  const { reports } = await loadExtensions(cwd, new Set());
  if (!reports.some((report) => report.name === name && report.scope === 'project')) {
    process.stderr.write(`no project extension named "${name}" was found\n`);
    return 2;
  }

  const path = join(cwd, LOCAL_SETTINGS);
  const raw = await readFile(path, 'utf8').catch(() => '{}');
  let settings: { extensionTrust?: string[] };
  try {
    settings = JSON.parse(raw) as { extensionTrust?: string[] };
  } catch (error) {
    process.stderr.write(`${path} is not valid JSON: ${(error as Error).message}\n`);
    return 2;
  }

  const current = new Set(settings.extensionTrust ?? []);
  if (trust) current.add(name);
  else current.delete(name);

  await mkdir(dirname(path), { recursive: true });
  await writeFile(
    path,
    `${JSON.stringify({ ...settings, extensionTrust: [...current].sort() }, null, 2)}\n`,
    'utf8',
  );
  process.stdout.write(`${trust ? 'trusted' : 'no longer trusting'} "${name}" (${path})\n`);
  return 0;
}
