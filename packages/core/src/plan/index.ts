import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { dataDir } from '@earshot/providers';

/**
 * A plan you can edit.
 *
 * The plan lives in a file rather than in the conversation, and that is the
 * whole point: a plan you can only accept or reject is a prompt. You edit it -
 * in $EDITOR, or in your own editor at the path this prints - and what gets
 * pinned into the run is what the file says when you approve it, not what the
 * model wrote.
 */
export function planPath(sessionId: string): string {
  return join(dataDir(), 'plans', `${sessionId}.md`);
}

export const PLAN_PROMPT =
  'Produce a plan and stop. Do not change anything: state what you would do, ' +
  'file by file, with the behaviour that changes and the behaviour that does not, ' +
  'and name anything you are unsure about rather than deciding it quietly. The ' +
  'user will edit this plan before approving it, so write it for them to change.';

export async function savePlan(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, text.endsWith('\n') ? text : `${text}\n`, 'utf8');
}

export async function readPlan(path: string): Promise<string | undefined> {
  const raw = await readFile(path, 'utf8').catch(() => undefined);
  return raw?.trim() === '' ? undefined : raw;
}

/**
 * The approved plan, as it goes into the system prompt.
 *
 * Named as the user's, because it is: they edited it and approved it, and the
 * model needs to treat a line it did not write as binding rather than as a
 * suggestion it made earlier.
 */
export function renderPlan(text: string): string {
  return (
    '<plan>\n' +
    'The user approved this plan for the work in progress, after editing it. It is\n' +
    'their instruction, not your earlier draft: where it differs from what you would\n' +
    'have done, it wins. If following it turns out to be wrong, say so and stop -\n' +
    'do not quietly do something else.\n\n' +
    `${text.trim()}\n</plan>`
  );
}

export interface EditorResult {
  edited: boolean;
  /** What to tell the user. Always set, including on success. */
  message: string;
}

/**
 * Opens the plan in $VISUAL or $EDITOR.
 *
 * Falls back to naming the path rather than guessing at an editor: launching
 * something the user did not configure, into a terminal earshot is already
 * drawing in, is a worse outcome than one line telling them where the file is.
 */
export async function openInEditor(
  path: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<EditorResult> {
  const editor = env.VISUAL ?? env.EDITOR;
  if (!editor || editor.trim() === '') {
    return {
      edited: false,
      message: `no $EDITOR set. Edit ${path} in your own editor, then run /plan approve.`,
    };
  }

  const code = await new Promise<number | null>((resolve) => {
    // The editor takes the terminal: it is interactive, and piping its stdio
    // would leave the user typing into something they cannot see.
    const child = spawn(editor, [path], { stdio: 'inherit', shell: true });
    child.on('error', () => resolve(-1));
    child.on('close', (status) => resolve(status));
  });

  if (code !== 0) {
    return {
      edited: false,
      message: `${editor} exited ${code ?? 'on a signal'}; ${path} is unchanged as far as earshot knows.`,
    };
  }
  return {
    edited: true,
    message: `edited ${path}. Run /plan approve to pin it, or /plan show to read it back.`,
  };
}
