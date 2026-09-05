import { randomUUID } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { Readable, Writable } from 'node:stream';
import * as acp from '@agentclientprotocol/sdk';
import {
  type CreatedSession,
  createSession,
  listSessions,
  type PermissionMode,
  type PromptChoice,
  VERSION,
} from '@earshot/core';
import { updateFromEvent } from './events.ts';

export interface AcpSessionRequest {
  cwd: string;
  resumeSessionId?: string;
}

export type AcpSessionFactory = (request: AcpSessionRequest) => Promise<CreatedSession>;

export interface AcpServerOptions {
  model: string;
  mode?: PermissionMode;
  apiKey?: string;
  sessionFactory?: AcpSessionFactory;
}

interface ActiveSession {
  session: CreatedSession;
  controller?: AbortController;
  activeToolCallId?: string;
}

export function createAcpApp(options: AcpServerOptions): acp.AgentApp {
  const sessions = new Map<string, ActiveSession>();
  const factory = options.sessionFactory ?? defaultSessionFactory(options);

  const app = acp
    .agent({ name: 'earshot' })
    .onRequest(acp.methods.agent.initialize, () => ({
      protocolVersion: acp.PROTOCOL_VERSION,
      agentCapabilities: { loadSession: true, promptCapabilities: { image: true } },
      agentInfo: { name: 'earshot', version: VERSION },
    }))
    .onRequest(acp.methods.agent.session.new, async (ctx) => {
      assertWorkspace(ctx.params.cwd);
      rejectClientMcp(ctx.params.mcpServers);
      const session = await factory({ cwd: ctx.params.cwd });
      const id = session.store?.id ?? randomUUID();
      const active: ActiveSession = { session };
      installClientRequests(active, id, ctx.client);
      sessions.set(id, active);
      return { sessionId: id };
    })
    .onRequest(acp.methods.agent.session.load, async (ctx) => {
      assertWorkspace(ctx.params.cwd);
      rejectClientMcp(ctx.params.mcpServers);
      await sessions.get(ctx.params.sessionId)?.session.dispose();
      const session = await factory({
        cwd: ctx.params.cwd,
        resumeSessionId: ctx.params.sessionId,
      });
      const active: ActiveSession = { session };
      installClientRequests(active, ctx.params.sessionId, ctx.client);
      sessions.set(ctx.params.sessionId, active);
      await replayHistory(ctx.params.sessionId, session, ctx.client);
      return {};
    })
    .onRequest(acp.methods.agent.session.prompt, async (ctx) => {
      const active = sessions.get(ctx.params.sessionId);
      if (!active) throw new Error(`unknown ACP session "${ctx.params.sessionId}"`);

      active.controller?.abort();
      const controller = new AbortController();
      active.controller = controller;
      let stopReason: acp.StopReason = 'end_turn';
      let failure: Error | undefined;

      try {
        for await (const event of active.session.agent.runTurn(
          promptText(ctx.params.prompt),
          controller.signal,
        )) {
          if (event.type === 'tool_start') active.activeToolCallId = event.call.toolCallId;
          if (event.type === 'turn_end') stopReason = stopReasonOf(event.reason);
          if (event.type === 'error') failure = new Error(event.error.message);
          const update = updateFromEvent(event, {
            tokens: active.session.agent.contextUse.tokens,
            window: active.session.agent.contextUse.window,
            costUsd: active.session.agent.costUsd,
          });
          if (update) {
            await ctx.client.notify(acp.methods.client.session.update, {
              sessionId: ctx.params.sessionId,
              update,
            });
          }
        }
      } finally {
        if (active.controller === controller) delete active.controller;
      }
      if (failure) throw failure;
      return { stopReason: controller.signal.aborted ? 'cancelled' : stopReason };
    })
    .onNotification(acp.methods.agent.session.cancel, (ctx) => {
      sessions.get(ctx.params.sessionId)?.controller?.abort();
    });

  app.onConnect((connection) => {
    void connection.closed.finally(async () => {
      await Promise.all([...sessions.values()].map(({ session }) => session.dispose()));
      sessions.clear();
    });
  });
  return app;
}

/** Serves one ACP connection over the process-style NDJSON transport. */
export async function runAcpServer(
  options: AcpServerOptions,
  input: NodeJS.ReadableStream = process.stdin,
  output: NodeJS.WritableStream = process.stdout,
): Promise<void> {
  const stream = acp.ndJsonStream(
    Writable.toWeb(output as NodeJS.WritableStream & import('node:stream').Writable),
    Readable.toWeb(input as NodeJS.ReadableStream & import('node:stream').Readable),
  );
  const connection = createAcpApp(options).connect(stream);
  await connection.closed;
}

function defaultSessionFactory(options: AcpServerOptions): AcpSessionFactory {
  return async ({ cwd, resumeSessionId }) => {
    let resume: { path: string } | undefined;
    if (resumeSessionId) {
      const found = (await listSessions(cwd)).find((session) => session.id === resumeSessionId);
      if (!found) throw new Error(`no session "${resumeSessionId}" for ${cwd}`);
      resume = { path: found.path };
    }
    return createSession({
      cwd,
      model: options.model,
      ...(options.mode ? { mode: options.mode } : {}),
      ...(options.apiKey ? { apiKey: options.apiKey } : {}),
      ...(resume ? { resume } : {}),
    });
  };
}

function installClientRequests(
  active: ActiveSession,
  sessionId: string,
  client: acp.AgentContext,
): void {
  active.session.installPrompt(async (request, reason) => {
    const response = await client.request(
      acp.methods.client.session.requestPermission,
      {
        sessionId,
        toolCall: {
          toolCallId: active.activeToolCallId ?? `permission-${randomUUID()}`,
          title: request.title,
          status: 'pending',
          rawInput: {
            tool: request.tool,
            target: request.target,
            reason,
            detail: request.detail,
          },
        },
        options: [
          { optionId: 'allow_once', name: 'Allow once', kind: 'allow_once' },
          { optionId: 'allow_always', name: 'Always allow this action', kind: 'allow_always' },
          { optionId: 'reject_once', name: 'Reject', kind: 'reject_once' },
        ],
      },
      active.controller ? { cancellationSignal: active.controller.signal } : {},
    );
    if (response.outcome.outcome === 'cancelled') return { kind: 'deny', message: 'cancelled' };
    return promptChoice(response.outcome.optionId);
  });

  active.session.installAsk(async (question, options) => {
    const property = {
      type: 'string',
      title: question,
      ...(options?.length ? { enum: options } : {}),
    } as const;
    const response = await client.request(
      acp.methods.client.elicitation.create,
      {
        mode: 'form',
        sessionId,
        message: question,
        requestedSchema: {
          type: 'object',
          properties: { answer: property },
          required: ['answer'],
        },
      },
      active.controller ? { cancellationSignal: active.controller.signal } : {},
    );
    if (response.action !== 'accept') return 'The user declined to answer.';
    const content = response.content as Record<string, unknown> | null | undefined;
    return String(content?.answer ?? '');
  });
}

function promptChoice(optionId: string): PromptChoice {
  if (optionId === 'allow_once') return { kind: 'allow-once' };
  if (optionId === 'allow_always') return { kind: 'allow-always', scope: 'session' };
  return { kind: 'deny' };
}

function promptText(blocks: acp.ContentBlock[]): import('@earshot/core').UserPromptPart[] {
  return blocks.map((block) => {
    if (block.type === 'text') return { type: 'text' as const, text: block.text };
    if (block.type === 'image') {
      return { type: 'image' as const, data: block.data, mediaType: block.mimeType };
    }
    if (block.type === 'resource_link') {
      return { type: 'text' as const, text: `[${block.name}](${block.uri})` };
    }
    throw new Error(`ACP prompt content "${block.type}" is not supported yet`);
  });
}

async function replayHistory(
  sessionId: string,
  session: CreatedSession,
  client: acp.AgentContext,
): Promise<void> {
  for (const message of session.agent.history) {
    if (message.role !== 'user' && message.role !== 'assistant') continue;
    for (const part of message.content) {
      if (part.type !== 'text') continue;
      await client.notify(acp.methods.client.session.update, {
        sessionId,
        update: {
          sessionUpdate: message.role === 'user' ? 'user_message_chunk' : 'agent_message_chunk',
          content: { type: 'text', text: part.text },
        },
      });
    }
  }
}

function stopReasonOf(
  reason: 'stop' | 'aborted' | 'max_steps' | 'error' | 'budget',
): acp.StopReason {
  if (reason === 'aborted') return 'cancelled';
  if (reason === 'max_steps') return 'max_turn_requests';
  // A budget stop is a configured limit, not the model declining: `refusal`
  // would tell the editor the wrong thing about who stopped and why.
  if (reason === 'budget') return 'max_turn_requests';
  return 'end_turn';
}

function assertWorkspace(cwd: string): void {
  if (!isAbsolute(cwd)) throw new Error(`ACP session cwd must be absolute: ${cwd}`);
}

function rejectClientMcp(servers: acp.McpServer[]): void {
  if (servers.length > 0) {
    // A RequestError rather than a plain Error: the JSON-RPC layer reports an
    // unrecognised throw as "Internal error" with no message, and a client told
    // only that would have no way to learn its servers were not taken - which is
    // the silent-ignore this rejection exists to avoid.
    throw acp.RequestError.invalidParams(
      undefined,
      'client-provided MCP servers are not supported; configure them in earshot',
    );
  }
}
