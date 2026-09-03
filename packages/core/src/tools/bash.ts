import { spawn } from 'node:child_process';
import { DEFAULT_MAX_OUTPUT_BYTES, exec } from './exec.ts';
import type { BackgroundJob, BackgroundJobs } from './jobs.ts';
import {
  bool,
  num,
  object,
  opt,
  optionalBoolean,
  optionalNumber,
  optionalString,
  requireString,
  str,
} from './schema.ts';
import { resolveShell } from './shell.ts';
import { defineTool, type Tool, ToolInputError, text } from './types.ts';

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 600_000;

interface BashInput {
  command: string;
  description?: string;
  timeoutMs?: number;
  background?: boolean;
}

export const bashTool: Tool<BashInput> = defineTool<BashInput>({
  name: 'bash',
  description:
    'Run a shell command in the working directory. Use `background: true` for ' +
    'long-running processes such as dev servers; the call returns immediately with ' +
    'a job id. Prefer the `read`, `glob` and `grep` tools over cat, find and grep.',
  readOnly: false,
  inputSchema: object(
    {
      command: str('The shell command to run.'),
      description: str('A short description of what the command does, in active voice.'),
      timeoutMs: num(
        `Timeout in milliseconds. Defaults to ${DEFAULT_TIMEOUT_MS}, max ${MAX_TIMEOUT_MS}.`,
      ),
      background: bool('Run detached and return a job id instead of waiting.'),
    },
    ['command'],
  ),
  parse: (input) => {
    const command = requireString(input, 'command');
    if (command.trim() === '') throw new ToolInputError('"command" must not be empty');
    const timeoutMs = optionalNumber(input, 'timeoutMs');
    if (timeoutMs !== undefined && (timeoutMs <= 0 || timeoutMs > MAX_TIMEOUT_MS)) {
      throw new ToolInputError(`"timeoutMs" must be between 1 and ${MAX_TIMEOUT_MS}`);
    }
    return {
      command,
      ...opt('description', optionalString(input, 'description')),
      ...opt('timeoutMs', timeoutMs),
      ...opt('background', optionalBoolean(input, 'background')),
    };
  },
  permission(input) {
    return {
      tool: 'Bash',
      // Matched against the raw command so a rule like `Bash(git *)` means what it
      // reads. The gate never sees a paraphrase of the command, only the command.
      target: input.command,
      title: input.command.split('\n')[0] ?? input.command,
      detail: input.command,
    };
  },
  async execute(input, ctx) {
    const shell = resolveShell(ctx.env);

    if (input.background) {
      const job = startBackground(
        shell.file,
        shell.args,
        input.command,
        ctx.cwd,
        ctx.env,
        ctx.jobs,
      );
      return {
        output: text(
          `started ${job.id} in the background\n\n` +
            'Read its output with the `bash_output` tool; it keeps running until the ' +
            'session ends or you kill it.',
        ),
        title: `${input.command} (background)`,
      };
    }

    const result = await exec(shell.file, [...shell.args, input.command], {
      cwd: ctx.cwd,
      env: ctx.env,
      signal: ctx.signal,
      timeoutMs: input.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    });

    const parts: string[] = [];
    if (result.stdout.trim() !== '') parts.push(result.stdout.trimEnd());
    if (result.stderr.trim() !== '') parts.push(`[stderr]\n${result.stderr.trimEnd()}`);
    if (result.timedOut) {
      parts.push(`[timed out after ${input.timeoutMs ?? DEFAULT_TIMEOUT_MS}ms and was killed]`);
    }
    if (result.code !== 0 && result.code !== null) parts.push(`[exit ${result.code}]`);
    if (parts.length === 0) parts.push('(no output)');

    const body = parts.join('\n');
    const truncated = body.length >= DEFAULT_MAX_OUTPUT_BYTES ? '\n\n[output truncated]' : '';

    return {
      output: text(body + truncated),
      // A non-zero exit is reported to the model as an error result so it does not
      // read a failed build as a successful one, but it is not thrown: the loop
      // must keep going and let the model react to the output.
      ...(result.code !== 0 && result.code !== null ? { isError: true } : {}),
      title: input.command.split('\n')[0] ?? input.command,
    };
  },
});

function startBackground(
  file: string,
  args: string[],
  command: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
  jobs: BackgroundJobs,
): BackgroundJob {
  const child = spawn(file, [...args, command], {
    cwd,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: false,
  });

  const job: BackgroundJob = {
    id: jobs.nextId(),
    command,
    output: '',
    exitCode: null,
    running: true,
    kill: () => {
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 2000).unref();
    },
  };

  const append = (chunk: Buffer) => {
    job.output = (job.output + chunk.toString('utf8')).slice(-DEFAULT_MAX_OUTPUT_BYTES);
  };
  child.stdout?.on('data', append);
  child.stderr?.on('data', append);
  child.on('close', (code) => {
    job.running = false;
    job.exitCode = code;
  });
  child.on('error', (error) => {
    job.running = false;
    job.output += `\n[failed to start: ${error.message}]`;
  });

  jobs.add(job);
  return job;
}

interface BashOutputInput {
  id: string;
  kill?: boolean;
}

export const bashOutputTool: Tool<BashOutputInput> = defineTool<BashOutputInput>({
  name: 'bash_output',
  description: 'Read the accumulated output of a background job started by `bash`.',
  readOnly: true,
  inputSchema: object(
    {
      id: str('The job id returned by `bash` with background: true.'),
      kill: bool('Terminate the job after reading its output.'),
    },
    ['id'],
  ),
  parse: (input) => ({
    id: requireString(input, 'id'),
    ...opt('kill', optionalBoolean(input, 'kill')),
  }),
  async execute(input, ctx) {
    const job = ctx.jobs.get(input.id);
    if (!job) throw new ToolInputError(`no background job "${input.id}"`);
    if (input.kill && job.running) job.kill();

    const status = job.running ? 'running' : `exited ${job.exitCode ?? 'unknown'}`;
    return {
      output: text(`[${job.id}: ${status}]\n${job.output === '' ? '(no output yet)' : job.output}`),
      title: `${job.id} (${status})`,
    };
  },
});
