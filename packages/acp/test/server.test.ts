import { describe, expect, test } from 'bun:test';
import * as acp from '@agentclientprotocol/sdk';
import type { AgentEvent, CreatedSession, UserPrompt } from '@earshot/core';
import type { Message } from '@earshot/providers';
import { type AcpSessionFactory, createAcpApp } from '../src/index.ts';

function fakeSession(
  id: string,
  events: AgentEvent[],
  history: Message[] = [],
): {
  session: CreatedSession;
  permission(): Parameters<CreatedSession['installPrompt']>[0] | undefined;
  ask(): Parameters<CreatedSession['installAsk']>[0] | undefined;
  aborted(): boolean;
  prompts: UserPrompt[];
} {
  let permission: Parameters<CreatedSession['installPrompt']>[0] | undefined;
  let ask: Parameters<CreatedSession['installAsk']>[0] | undefined;
  let aborted = false;
  const prompts: UserPrompt[] = [];
  const agent = {
    history,
    costUsd: 0,
    permissionMode: 'ask',
    contextUse: { tokens: 10, window: 100 },
    async *runTurn(prompt: UserPrompt, signal: AbortSignal) {
      prompts.push(prompt);
      await new Promise((resolve) => setTimeout(resolve, 0));
      aborted = signal.aborted;
      for (const event of events) yield event;
    },
  };

  return {
    session: {
      agent,
      store: { id },
      problems: [],
      resumed: history.length,
      skills: [],
      commands: [],
      installPrompt(value) {
        permission = value;
      },
      installAsk(value) {
        ask = value;
      },
      async branch() {
        return [];
      },
      async rewindTo() {
        return 0;
      },
      async fork() {
        return undefined;
      },
      async undo() {
        return undefined;
      },
      async dispose() {},
    } as unknown as CreatedSession,
    permission: () => permission,
    ask: () => ask,
    aborted: () => aborted,
    prompts,
  };
}

function harness(events: AgentEvent[] = [], history: Message[] = []) {
  const made = fakeSession('session-1', events, history);
  const requests: Array<{ cwd: string; resumeSessionId?: string }> = [];
  const factory: AcpSessionFactory = async (request) => {
    requests.push(request);
    return made.session;
  };
  const app = createAcpApp({ model: 'test/model', sessionFactory: factory });
  return { app, made, requests };
}

function testClient(updates: acp.SessionUpdate[] = []) {
  return acp
    .client({ name: 'earshot-test' })
    .onNotification(acp.methods.client.session.update, (ctx) => {
      updates.push(ctx.params.update);
    })
    .onRequest(acp.methods.client.session.requestPermission, () => ({
      outcome: { outcome: 'selected', optionId: 'allow_once' },
    }))
    .onRequest(acp.methods.client.elicitation.create, () => ({
      action: 'accept',
      content: { answer: 'because tests say so' },
    }));
}

describe('the ACP server', () => {
  test('negotiates stable v1 and advertises only implemented capabilities', async () => {
    const { app } = harness();
    const response = await testClient().connectWith(app, (client) =>
      client.request(acp.methods.agent.initialize, {
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: {},
      }),
    );

    expect(response.protocolVersion).toBe(acp.PROTOCOL_VERSION);
    expect(response.agentCapabilities).toEqual({
      loadSession: true,
      promptCapabilities: { image: true },
    });
  });

  test('creates and loads persistent sessions for the requested workspace', async () => {
    const { app, requests } = harness();
    await testClient().connectWith(app, async (client) => {
      const created = await client.request(acp.methods.agent.session.new, {
        cwd: '/workspace/project',
        mcpServers: [],
      });
      expect(created.sessionId).toBe('session-1');

      await client.request(acp.methods.agent.session.load, {
        cwd: '/workspace/project',
        sessionId: 'older-session',
        mcpServers: [],
      });
    });

    expect(requests).toEqual([
      { cwd: '/workspace/project' },
      { cwd: '/workspace/project', resumeSessionId: 'older-session' },
    ]);
  });

  // A promise in docs/compatibility.md with nothing enforcing it until now: a
  // client that sends MCP definitions is told they were not taken, rather than
  // being left to believe its servers loaded. Silently ignoring them would look
  // identical to supporting them right up until a tool call failed.
  test('rejects client-provided MCP servers rather than ignoring them', async () => {
    const { app, requests } = harness();
    await testClient().connectWith(app, async (client) => {
      const failure = await client
        .request(acp.methods.agent.session.new, {
          cwd: '/workspace/project',
          mcpServers: [{ name: 'theirs', command: 'node', args: [], env: [] }],
        })
        .then(
          () => undefined,
          (error: Error) => error,
        );

      expect(failure?.message).toContain('client-provided MCP servers are not supported');
    });
    // And no session was created for the rejected request.
    expect(requests).toEqual([]);
  });

  test('streams text, reasoning, tool calls, results and usage as session updates', async () => {
    const updates: acp.SessionUpdate[] = [];
    const { app } = harness([
      { type: 'text_delta', text: 'hello' },
      { type: 'reasoning_delta', text: 'thinking' },
      {
        type: 'tool_start',
        call: {
          type: 'tool_call',
          toolCallId: 'call-1',
          toolName: 'read',
          input: { path: 'a.ts' },
        },
      },
      {
        type: 'tool_end',
        toolCallId: 'call-1',
        toolName: 'read',
        result: { title: 'a.ts', output: { type: 'text', value: 'contents' } },
      },
      {
        type: 'usage',
        usage: { inputTokens: 10, outputTokens: 2 },
        costUsd: 0.01,
      },
      { type: 'turn_end', reason: 'stop' },
    ]);

    const response = await testClient(updates).connectWith(app, async (client) => {
      const created = await client.request(acp.methods.agent.session.new, {
        cwd: '/workspace/project',
        mcpServers: [],
      });
      return client.request(acp.methods.agent.session.prompt, {
        sessionId: created.sessionId,
        prompt: [{ type: 'text', text: 'hi' }],
      });
    });

    expect(response.stopReason).toBe('end_turn');
    expect(updates.map((update) => update.sessionUpdate)).toEqual([
      'agent_message_chunk',
      'agent_thought_chunk',
      'tool_call',
      'tool_call_update',
      'usage_update',
    ]);
    expect(updates[3]).toMatchObject({ status: 'completed', rawOutput: 'contents' });
  });

  test('passes ACP image blocks through the unified prompt type', async () => {
    const { app, made } = harness([{ type: 'turn_end', reason: 'stop' }]);
    await testClient().connectWith(app, async (client) => {
      const created = await client.request(acp.methods.agent.session.new, {
        cwd: '/workspace/project',
        mcpServers: [],
      });
      await client.request(acp.methods.agent.session.prompt, {
        sessionId: created.sessionId,
        prompt: [
          { type: 'text', text: 'describe it' },
          { type: 'image', data: 'aGVsbG8=', mimeType: 'image/png' },
        ],
      });
    });

    expect(made.prompts).toEqual([
      [
        { type: 'text', text: 'describe it' },
        { type: 'image', data: 'aGVsbG8=', mediaType: 'image/png' },
      ],
    ]);
  });

  test('routes permission and ask-user requests through the client', async () => {
    const { app, made } = harness();
    await testClient().connectWith(app, async (client) => {
      const created = await client.request(acp.methods.agent.session.new, {
        cwd: '/workspace/project',
        mcpServers: [],
      });

      const permission = made.permission();
      const choice = await permission?.(
        {
          tool: 'Write',
          target: 'a.ts',
          title: 'Write a.ts',
          detail: 'the real diff',
        },
        'no allow rule matched',
      );
      expect(choice).toEqual({ kind: 'allow-once' });

      const answer = await made.ask()?.('Why?', ['one', 'two']);
      expect(answer).toBe('because tests say so');
      expect(created.sessionId).toBe('session-1');
    });
  });

  test('cancels the active turn and reports a cancelled stop reason', async () => {
    const { app, made } = harness([{ type: 'turn_end', reason: 'aborted' }]);
    const response = await testClient().connectWith(app, async (client) => {
      const created = await client.request(acp.methods.agent.session.new, {
        cwd: '/workspace/project',
        mcpServers: [],
      });
      const pending = client.request(acp.methods.agent.session.prompt, {
        sessionId: created.sessionId,
        prompt: [{ type: 'text', text: 'wait' }],
      });
      await client.notify(acp.methods.agent.session.cancel, { sessionId: created.sessionId });
      return pending;
    });

    expect(made.aborted()).toBe(true);
    expect(response.stopReason).toBe('cancelled');
  });
});
