import { describe, expect, test } from 'bun:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { fromClient, type McpClient } from '../src/client.ts';

type Handler = (name: string, args: unknown) => Promise<unknown>;

/**
 * A real MCP server and a real client, joined in memory. The protocol is
 * exercised for real; only the process and the socket are absent.
 */
async function connected(
  handle: Handler,
  callTimeoutMs = 500,
): Promise<{
  client: McpClient;
  server: Server;
}> {
  const server = new Server({ name: 'test', version: '1' }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: [{ name: 'work', description: 'works', inputSchema: { type: 'object' } }],
  }));
  server.setRequestHandler(
    CallToolRequestSchema,
    (request) => handle(request.params.name, request.params.arguments) as never,
  );

  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const raw = new Client({ name: 'earshot', version: 'test' }, { capabilities: {} });
  await Promise.all([server.connect(serverSide), raw.connect(clientSide)]);
  return { client: fromClient('test', raw, callTimeoutMs), server };
}

const signal = () => new AbortController().signal;

describe('talking to a server', () => {
  test('brings back its text content', async () => {
    const { client } = await connected(async () => ({
      content: [{ type: 'text', text: 'the answer' }],
    }));

    expect(await client.callTool('work', {}, signal())).toEqual({
      text: 'the answer',
      isError: false,
    });
    await client.close();
  });

  test('keeps a tool’s own failure flagged as an error', async () => {
    const { client } = await connected(async () => ({
      content: [{ type: 'text', text: 'no such repository' }],
      isError: true,
    }));

    const result = await client.callTool('work', {}, signal());
    expect(result.isError).toBe(true);
    expect(result.text).toBe('no such repository');
    await client.close();
  });

  test('names content it cannot show rather than dropping it silently', async () => {
    const { client } = await connected(async () => ({
      content: [
        { type: 'text', text: 'here is the chart' },
        { type: 'image', data: 'AAAA', mimeType: 'image/png' },
      ],
    }));

    const result = await client.callTool('work', {}, signal());
    expect(result.text).toContain('here is the chart');
    expect(result.text).toContain('image');
    await client.close();
  });

  test('lists the tools the server offers', async () => {
    const { client } = await connected(async () => ({ content: [] }));
    expect((await client.listTools()).map((tool) => tool.name)).toEqual(['work']);
    await client.close();
  });
});

describe('a server that misbehaves', () => {
  test('is abandoned when it never answers, instead of wedging the turn', async () => {
    const { client } = await connected(() => new Promise(() => {}), 100);

    const result = await client.callTool('work', {}, signal());
    expect(result.isError).toBe(true);
    expect(result.text).toContain('did not answer in time');
    await client.close();
  });

  test('reports an error it raised as a result, not a throw', async () => {
    const { client } = await connected(async () => {
      throw new Error('the upstream token expired');
    });

    const result = await client.callTool('work', {}, signal());
    expect(result.isError).toBe(true);
    expect(result.text).toContain('the upstream token expired');
    await client.close();
  });

  test('answers plainly once it has gone away', async () => {
    const { client, server } = await connected(async () => ({ content: [] }));
    await server.close();

    const result = await client.callTool('work', {}, signal());
    expect(result.isError).toBe(true);
    expect(result.text).toContain('work');
    await client.close();
  });

  test('is abandoned when the caller interrupts the turn', async () => {
    const { client } = await connected(() => new Promise(() => {}), 10_000);
    const controller = new AbortController();
    const pending = client.callTool('work', {}, controller.signal);
    controller.abort();

    expect((await pending).isError).toBe(true);
    await client.close();
  });
});
