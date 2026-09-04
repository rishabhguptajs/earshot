import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { ServerConfig } from './config.ts';

export interface McpToolDescriptor {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface McpCallResult {
  text: string;
  isError: boolean;
}

/**
 * What the rest of earshot needs from a server. An interface rather than the
 * SDK's `Client` so the manager, the tool bridge and the permission path can be
 * tested against a server that hangs, dies or floods without spawning one.
 */
export interface McpClient {
  readonly name: string;
  listTools(signal?: AbortSignal): Promise<McpToolDescriptor[]>;
  callTool(tool: string, args: unknown, signal: AbortSignal): Promise<McpCallResult>;
  close(): Promise<void>;
  /** Recent stderr, for explaining a server that failed rather than guessing. */
  diagnostics(): string;
}

export const DEFAULT_CONNECT_TIMEOUT_MS = 30_000;
export const DEFAULT_CALL_TIMEOUT_MS = 60_000;
/**
 * A server can return as much text as it likes, and a large one would blow the
 * context window before the shapers ever see it. Capped here, at the boundary,
 * with the middle dropped rather than the tail: the end of a result is usually
 * where the answer is.
 */
export const MAX_RESULT_CHARS = 40_000;
const STDERR_KEEP_CHARS = 4_000;

export interface ConnectOptions {
  connectTimeoutMs?: number;
  callTimeoutMs?: number;
  cwd: string;
  env: NodeJS.ProcessEnv;
}

/** Thrown when a server cannot be reached at all; the manager reports and skips it. */
export class McpConnectError extends Error {
  constructor(
    readonly server: string,
    message: string,
  ) {
    super(`mcp server "${server}" failed to start: ${message}`);
    this.name = 'McpConnectError';
  }
}

class SdkClient implements McpClient {
  private closed = false;
  private stderr = '';

  constructor(
    readonly name: string,
    private readonly client: Client,
    private readonly callTimeoutMs: number,
    private readonly onStderr: (chunk: string) => void = () => {},
  ) {}

  record(chunk: string): void {
    this.stderr = `${this.stderr}${chunk}`.slice(-STDERR_KEEP_CHARS);
    this.onStderr(chunk);
  }

  diagnostics(): string {
    return this.stderr.trim();
  }

  async listTools(signal?: AbortSignal): Promise<McpToolDescriptor[]> {
    const result = await this.client.listTools(
      {},
      { timeout: this.callTimeoutMs, ...(signal ? { signal } : {}) },
    );
    return result.tools.map((tool) => ({
      name: tool.name,
      description: tool.description ?? '',
      inputSchema: (tool.inputSchema ?? { type: 'object' }) as Record<string, unknown>,
    }));
  }

  /**
   * A call never throws: a dead server, a timeout and a tool that reports its
   * own failure are all data the model reads and reacts to, exactly like a
   * failing built-in tool.
   */
  async callTool(tool: string, args: unknown, signal: AbortSignal): Promise<McpCallResult> {
    if (this.closed) {
      const why = this.diagnostics();
      return {
        isError: true,
        text:
          `the "${this.name}" server is no longer running, so ${tool} cannot be called` +
          (why ? `. Its last output was:\n${why}` : '. Tell the user it needs restarting.'),
      };
    }
    try {
      const result = await this.client.callTool(
        { name: tool, arguments: asArguments(args) },
        undefined,
        { timeout: this.callTimeoutMs, signal },
      );
      return {
        text: renderContent(result.content),
        isError: result.isError === true,
      };
    } catch (error) {
      return { isError: true, text: describeFailure(this.name, tool, error, this.diagnostics()) };
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.client.close().catch(() => undefined);
  }

  markClosed(): void {
    this.closed = true;
  }
}

/**
 * Wraps an already-connected SDK client. Separate from `connectServer` so a test
 * can drive the same wrapper over an in-memory transport - the hang, the crash
 * and the flood are the cases worth testing, and none of them need a process.
 */
export function fromClient(name: string, client: Client, callTimeoutMs: number): McpClient {
  return new SdkClient(name, client, callTimeoutMs);
}

/** Starts one server and completes the MCP handshake. */
export async function connectServer(
  config: ServerConfig,
  options: ConnectOptions,
): Promise<McpClient> {
  const client = new Client({ name: 'earshot', version: '0.0.1' }, { capabilities: {} });

  let transport: StdioClientTransport | StreamableHTTPClientTransport;
  if (config.transport.type === 'stdio') {
    transport = new StdioClientTransport({
      command: config.transport.command,
      args: config.transport.args,
      // The server's own environment, not the whole of ours: a server has no
      // business reading the user's API keys unless its config named them.
      env: { ...inheritedEnv(options.env), ...config.transport.env },
      cwd: config.transport.cwd ?? options.cwd,
      // Piped rather than inherited: a chatty server writing to our stderr would
      // scribble over the TUI's own output.
      stderr: 'pipe',
    });
  } else {
    transport = new StreamableHTTPClientTransport(new URL(config.transport.url), {
      requestInit: { headers: config.transport.headers },
    });
  }

  const wrapper = new SdkClient(
    config.name,
    client,
    config.timeoutMs ?? options.callTimeoutMs ?? DEFAULT_CALL_TIMEOUT_MS,
  );

  try {
    // The SDK's transport classes declare `sessionId: string | undefined` against
    // an interface declaring `sessionId?: string`, which `exactOptionalPropertyTypes`
    // treats as a mismatch. The cast is to the SDK's own parameter type, so it
    // narrows nothing we rely on.
    await client.connect(transport as Parameters<Client['connect']>[0], {
      timeout: options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS,
    });
  } catch (error) {
    await client.close().catch(() => undefined);
    throw new McpConnectError(config.name, (error as Error).message);
  }

  if (transport instanceof StdioClientTransport) {
    transport.stderr?.on('data', (chunk: Buffer) => wrapper.record(chunk.toString('utf8')));
  }
  // A server that exits after a successful handshake must not leave calls
  // hanging until their timeout; the next call reports it plainly instead.
  transport.onclose = () => wrapper.markClosed();

  return wrapper;
}

/**
 * The variables a spawned server gets when its config names none. Deliberately
 * small: PATH and the platform's own variables, so the command resolves, and
 * nothing that carries a credential.
 */
function inheritedEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const keep = [
    'PATH',
    'HOME',
    'USER',
    'SHELL',
    'LANG',
    'LC_ALL',
    'TMPDIR',
    'TEMP',
    'TMP',
    'APPDATA',
    'LOCALAPPDATA',
    'PROGRAMFILES',
    'PROGRAMFILES(X86)',
    'SYSTEMROOT',
    'WINDIR',
    'COMSPEC',
    'PATHEXT',
    'USERPROFILE',
    'HOMEDRIVE',
    'HOMEPATH',
  ];
  const out: Record<string, string> = {};
  for (const key of keep) {
    const value = env[key];
    if (typeof value === 'string') out[key] = value;
  }
  return out;
}

function asArguments(args: unknown): Record<string, unknown> {
  return typeof args === 'object' && args !== null && !Array.isArray(args)
    ? (args as Record<string, unknown>)
    : {};
}

/**
 * MCP content blocks reduced to text. Images and audio are named rather than
 * carried: earshot has no image input yet, and silently dropping a block would
 * leave the model reasoning about a result it cannot see.
 */
export function renderContent(content: unknown): string {
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const block of content) {
    if (typeof block !== 'object' || block === null) continue;
    const item = block as Record<string, unknown>;
    if (item.type === 'text' && typeof item.text === 'string') {
      parts.push(item.text);
    } else if (item.type === 'resource' && typeof item.resource === 'object') {
      const resource = item.resource as Record<string, unknown>;
      parts.push(
        typeof resource.text === 'string'
          ? `${resource.uri ?? 'resource'}:\n${resource.text}`
          : `[resource ${String(resource.uri ?? '')} (${String(
              resource.mimeType ?? 'unknown',
            )}), not text]`,
      );
    } else if (item.type === 'resource_link') {
      parts.push(`[resource link ${String(item.uri ?? '')}]`);
    } else {
      parts.push(`[${String(item.type ?? 'unknown')} content, which earshot cannot show yet]`);
    }
  }
  return truncate(parts.join('\n'));
}

export function truncate(value: string, limit = MAX_RESULT_CHARS): string {
  if (value.length <= limit) return value;
  const head = Math.floor(limit * 0.6);
  const tail = limit - head;
  const dropped = value.length - limit;
  return `${value.slice(0, head)}\n\n[... ${dropped} characters dropped by earshot ...]\n\n${value.slice(-tail)}`;
}

function describeFailure(server: string, tool: string, error: unknown, stderr: string): string {
  const message = (error as Error).message ?? String(error);
  const timedOut = /timed out|timeout/i.test(message);
  const detail = stderr ? `\n\nThe server's last output was:\n${truncate(stderr, 2_000)}` : '';
  return timedOut
    ? `${server}__${tool} did not answer in time and was abandoned. Do not retry it without ` +
        `saying so; tell the user the server is not responding.${detail}`
    : `${server}__${tool} failed: ${message}${detail}`;
}
