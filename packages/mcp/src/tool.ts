import { createHash } from 'node:crypto';
import { defineTool, type Tool, ToolInputError, text } from '@earshot/core';
import type { McpClient, McpToolDescriptor } from './client.ts';

/**
 * Providers reject a tool name longer than this, so a server with long names
 * would otherwise break every request rather than just its own tools.
 */
export const MAX_TOOL_NAME = 64;

/** The separator between a server and its tool. Server names may not contain it. */
export const NAMESPACE = '__';

/**
 * `server__tool`, shortened deterministically when the pair is too long for a
 * provider to accept. The hash keeps two long names on the same server distinct;
 * being deterministic keeps a permission rule the user saved yesterday matching
 * the same tool today.
 */
export function namespacedName(server: string, tool: string): string {
  const full = `${server}${NAMESPACE}${tool}`;
  if (full.length <= MAX_TOOL_NAME) return full;
  const digest = createHash('sha256').update(full).digest('hex').slice(0, 6);
  const room = MAX_TOOL_NAME - server.length - NAMESPACE.length - digest.length - 1;
  return `${server}${NAMESPACE}${tool.slice(0, Math.max(1, room))}_${digest}`;
}

/**
 * Wraps one server-supplied tool as an earshot tool.
 *
 * Two properties are not negotiable. It is never `readOnly`, whatever the server
 * says about itself: `readOnlyHint` is an assertion by the same party that wrote
 * the tool, and believing it would mean a server could run in parallel and
 * without a prompt by claiming to be harmless. And it declares a
 * `permission()`, so a server-supplied tool goes through exactly the gate a
 * built-in does - the gate that would otherwise be decorative the moment anyone
 * configured a server.
 */
export function mcpTool(
  client: McpClient,
  descriptor: McpToolDescriptor,
  name = namespacedName(client.name, descriptor.name),
): Tool<Record<string, unknown>> {
  return defineTool<Record<string, unknown>>({
    name,
    description:
      `${descriptor.description || descriptor.name} ` +
      `(provided by the "${client.name}" MCP server)`.trim(),
    readOnly: false,
    inputSchema: schemaOf(descriptor),
    parse: (input) => {
      if (input === undefined || input === null) return {};
      if (typeof input !== 'object' || Array.isArray(input)) {
        throw new ToolInputError('expected an object of arguments');
      }
      return input as Record<string, unknown>;
    },
    // The rule name is `Mcp` for every server, so "always allow" persists as
    // `Mcp(github__create_issue)` - one tool, not one server. A server that adds
    // a tool after the user approved a different one is not covered by it.
    permission: (input) => ({
      tool: 'Mcp',
      target: name,
      title: `${descriptor.name} on the "${client.name}" MCP server`,
      // The arguments verbatim, because that is the thing being judged. A
      // summary here is where a create_issue that posts your source code hides.
      detail: `${name}(${JSON.stringify(input, null, 2)})`,
    }),
    async execute(input, ctx) {
      const result = await client.callTool(descriptor.name, input, ctx.signal);
      return {
        output: text(result.text || '(the server returned no content)'),
        ...(result.isError ? { isError: true } : {}),
        title: name,
      };
    },
  });
}

/**
 * The server's own schema, passed through. It describes arguments the server
 * will validate itself, so rewriting it here would only add a second opinion -
 * but it must at least be an object schema, or providers reject the request.
 */
function schemaOf(descriptor: McpToolDescriptor): Record<string, unknown> {
  const schema = descriptor.inputSchema;
  if (typeof schema !== 'object' || schema === null || Array.isArray(schema)) {
    return { type: 'object', properties: {} };
  }
  if (schema.type !== 'object') return { ...schema, type: 'object' };
  return schema;
}
