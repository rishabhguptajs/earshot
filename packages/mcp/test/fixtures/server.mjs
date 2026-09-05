// A real MCP server over stdio, for the one test that spawns a process.
// Deliberately small and dependency-light apart from the SDK itself.
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const server = new Server({ name: 'fixture', version: '1' }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, () => ({
  tools: [
    {
      name: 'echo',
      description: 'echoes its argument',
      inputSchema: { type: 'object', properties: { value: { type: 'string' } } },
    },
    {
      name: 'shout_env',
      description: 'reports whether a named variable reached this process',
      inputSchema: { type: 'object', properties: { name: { type: 'string' } } },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, (request) => {
  const { name, arguments: args = {} } = request.params;
  if (name === 'echo') {
    return { content: [{ type: 'text', text: String(args.value ?? '') }] };
  }
  if (name === 'shout_env') {
    const value = process.env[String(args.name ?? '')];
    return { content: [{ type: 'text', text: value === undefined ? 'absent' : `present:${value}` }] };
  }
  return { content: [{ type: 'text', text: `no tool named ${name}` }], isError: true };
});

// Written to stderr so the transport's stdout stays pure JSON-RPC; the test
// asserts this reaches the diagnostics buffer rather than the user's terminal.
process.stderr.write('fixture server ready\n');

await server.connect(new StdioServerTransport());
