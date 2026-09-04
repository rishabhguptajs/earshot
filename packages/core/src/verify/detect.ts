import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { MEMORY_FILENAMES } from '../context/agents-md.ts';

export interface VerifyCommand {
  command: string;
  /** Where it came from, so the user can see why this command and not another. */
  source: string;
}

/**
 * Finds the command that proves the change works.
 *
 * Declaration beats detection: a project that says how it is tested is telling
 * the truth about itself, while a `test` script can be a placeholder that exits
 * zero. Nothing is invented - if none of these turn anything up, verification
 * simply does not run and the agent has to say so rather than claim it passed.
 */
export async function detectTestCommand(cwd: string): Promise<VerifyCommand | undefined> {
  return (
    (await fromSettings(cwd)) ??
    (await fromInstructions(cwd)) ??
    (await fromPackageJson(cwd)) ??
    (await fromMakefile(cwd))
  );
}

async function fromSettings(cwd: string): Promise<VerifyCommand | undefined> {
  for (const name of ['settings.local.json', 'settings.json']) {
    const path = join(cwd, '.earshot', name);
    const raw = await readFile(path, 'utf8').catch(() => undefined);
    if (raw === undefined) continue;
    try {
      const parsed = JSON.parse(raw) as { verify?: { test?: string } };
      const command = parsed.verify?.test;
      if (typeof command === 'string' && command.trim() !== '') {
        return { command: command.trim(), source: `.earshot/${name}` };
      }
    } catch {
      // A settings file that does not parse is reported elsewhere; here it just
      // means no declared command.
    }
  }
  return undefined;
}

/** `- \`bun test\` - test suite`, the shape AGENTS.md documents commands in. */
const INSTRUCTION_LINE = /^\s*[-*]?\s*`([^`]+)`\s*[-–:]\s*(.*)$/;

async function fromInstructions(cwd: string): Promise<VerifyCommand | undefined> {
  for (const name of MEMORY_FILENAMES) {
    const raw = await readFile(join(cwd, name), 'utf8').catch(() => undefined);
    if (raw === undefined) continue;
    for (const line of raw.split('\n')) {
      const match = INSTRUCTION_LINE.exec(line);
      const command = match?.[1]?.trim();
      const description = match?.[2] ?? '';
      if (!command || !/\btests?\b|\btest suite\b/i.test(description)) continue;
      // "`bun test` - test suite", not "`bun run lint` - biome".
      if (!/\btests?\b/i.test(command)) continue;
      return { command, source: name };
    }
  }
  return undefined;
}

async function fromPackageJson(cwd: string): Promise<VerifyCommand | undefined> {
  const raw = await readFile(join(cwd, 'package.json'), 'utf8').catch(() => undefined);
  if (raw === undefined) return undefined;
  try {
    const parsed = JSON.parse(raw) as { scripts?: Record<string, string> };
    const script = parsed.scripts?.test;
    if (typeof script !== 'string' || script.trim() === '') return undefined;
    // The npm-init default, which exits 1 and proves nothing.
    if (/no test specified/i.test(script)) return undefined;
    return { command: 'npm test', source: 'package.json' };
  } catch {
    return undefined;
  }
}

async function fromMakefile(cwd: string): Promise<VerifyCommand | undefined> {
  const raw = await readFile(join(cwd, 'Makefile'), 'utf8').catch(() => undefined);
  if (raw === undefined) return undefined;
  return /^test\s*:/m.test(raw) ? { command: 'make test', source: 'Makefile' } : undefined;
}
