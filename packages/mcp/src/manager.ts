import type { Tool } from '@earshot/core';
import { type ConnectOptions, connectServer, type McpClient } from './client.ts';
import { loadMcpConfig, type ServerConfig, TRUST_NOTE } from './config.ts';
import { mcpTool, namespacedName } from './tool.ts';

export type ServerStatus = 'ready' | 'failed' | 'untrusted';

export interface ServerReport {
  name: string;
  scope: ServerConfig['scope'];
  status: ServerStatus;
  toolCount: number;
  detail?: string;
}

export interface ManagerOptions {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  connectTimeoutMs?: number;
  callTimeoutMs?: number;
  /** Substituted in tests, so no test spawns a process or opens a socket. */
  connect?: (config: ServerConfig, options: ConnectOptions) => Promise<McpClient>;
}

/**
 * Every configured MCP server, and the tools they contribute.
 *
 * One server failing is the normal case, not an exception: a missing binary, a
 * bad token, a server that hangs on start. Each is reported and skipped, and the
 * session runs with the tools it does have - a config typo should not be the
 * difference between having a coding agent and not having one.
 */
export class McpManager {
  private constructor(
    private readonly clients: McpClient[],
    private readonly registered: Tool<never>[],
    readonly reports: ServerReport[],
    readonly problems: string[],
  ) {}

  static async start(options: ManagerOptions): Promise<McpManager> {
    const { servers, problems } = await loadMcpConfig(options.cwd);
    const connect = options.connect ?? connectServer;
    const connectOptions: ConnectOptions = {
      cwd: options.cwd,
      env: options.env ?? process.env,
      ...(options.connectTimeoutMs !== undefined
        ? { connectTimeoutMs: options.connectTimeoutMs }
        : {}),
      ...(options.callTimeoutMs !== undefined ? { callTimeoutMs: options.callTimeoutMs } : {}),
    };

    const clients: McpClient[] = [];
    const tools: Tool<never>[] = [];
    const reports: ServerReport[] = [];
    const taken = new Set<string>();

    // Started concurrently: a dozen servers each taking a second to hand shake
    // is a dozen seconds of staring at nothing when it could be one.
    const started = await Promise.all(
      servers.map(async (config) => {
        if (!config.enabled) return { config, error: TRUST_NOTE };
        try {
          const client = await connect(config, connectOptions);
          return { config, client };
        } catch (error) {
          return { config, error: (error as Error).message };
        }
      }),
    );

    for (const outcome of started) {
      const { config } = outcome;
      if (!('client' in outcome) || !outcome.client) {
        reports.push({
          name: config.name,
          scope: config.scope,
          status: config.enabled ? 'failed' : 'untrusted',
          toolCount: 0,
          ...(outcome.error ? { detail: outcome.error } : {}),
        });
        continue;
      }

      const client = outcome.client;
      clients.push(client);
      let descriptors: Awaited<ReturnType<McpClient['listTools']>>;
      try {
        descriptors = await client.listTools();
      } catch (error) {
        await client.close().catch(() => undefined);
        reports.push({
          name: config.name,
          scope: config.scope,
          status: 'failed',
          toolCount: 0,
          detail: `listing its tools failed: ${(error as Error).message}`,
        });
        continue;
      }

      let added = 0;
      for (const descriptor of descriptors) {
        const name = namespacedName(config.name, descriptor.name);
        // Two tools can only collide here by a server declaring the same name
        // twice, or by a hashed shortening meeting itself. Skipped rather than
        // thrown: one malformed tool must not cost the session the other forty.
        if (taken.has(name)) continue;
        taken.add(name);
        tools.push(mcpTool(client, descriptor, name) as unknown as Tool<never>);
        added++;
      }
      reports.push({ name: config.name, scope: config.scope, status: 'ready', toolCount: added });
    }

    return new McpManager(clients, tools, reports, problems);
  }

  tools(): Tool<never>[] {
    return [...this.registered];
  }

  /** One line per server, for the CLI and for the startup notice in the TUI. */
  summary(): string[] {
    return this.reports.map((report) => {
      if (report.status === 'ready') {
        return `${report.name}: ${report.toolCount} tool${report.toolCount === 1 ? '' : 's'}`;
      }
      if (report.status === 'untrusted') return `${report.name}: ${TRUST_NOTE}`;
      return `${report.name}: ${report.detail ?? 'failed to start'}`;
    });
  }

  async close(): Promise<void> {
    await Promise.all(this.clients.map((client) => client.close().catch(() => undefined)));
  }
}
