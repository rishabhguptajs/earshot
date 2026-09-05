import { readdir } from 'node:fs/promises';
import { basename, extname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { defineTool, type PermissionRequest, type Tool, type ToolContext } from '@earshot/core';
import { LOCAL_SETTINGS, namespacedName } from '@earshot/mcp';
import { configDir } from '@earshot/providers';

/** Where extensions live, under the project and under the config directory. */
export const PROJECT_EXTENSIONS = join('.earshot', 'extensions');

const LOADABLE = new Set(['.ts', '.mts', '.js', '.mjs']);
const NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

export const EXTENSION_TRUST_NOTE =
  'checked in under this project and not loaded. Run `earshot extensions trust <name>` ' +
  'to allow it - an extension runs inside earshot, with everything earshot can reach, ' +
  'from the moment it is imported.';

export type ExtensionStatus = 'ready' | 'failed' | 'untrusted';

export interface ExtensionReport {
  name: string;
  scope: 'global' | 'project';
  status: ExtensionStatus;
  toolCount: number;
  detail?: string;
}

export interface LoadedExtensions {
  tools: Tool<never>[];
  reports: ExtensionReport[];
}

/**
 * The shape an extension module default-exports.
 *
 * Deliberately importable from nowhere: earshot ships as a bundled binary, not
 * as a library, so requiring `import { defineExtension } from 'earshot'` would
 * mean an extension only works when earshot happens to be resolvable from the
 * project. The shape is structural and validated on load instead.
 */
export interface ExtensionModule {
  name?: string;
  tools?: ExtensionTool[];
}

export interface ExtensionTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  readOnly?: boolean;
  permission?(input: Record<string, unknown>, ctx: ToolContext): PermissionRequest;
  execute(input: Record<string, unknown>, ctx: ToolContext): Promise<unknown>;
}

/**
 * Loads every extension module in scope.
 *
 * An extension is not sandboxed and cannot be: it is user TypeScript running in
 * earshot's own process, which is the whole point of it being in-process rather
 * than an MCP server. So the boundary is not what it may do once loaded, but
 * whether it is loaded at all - a module checked into a repository the user
 * cloned stays inert until `earshot extensions trust` names it, exactly as a
 * project-defined stdio MCP server does.
 */
export async function loadExtensions(cwd: string, trusted: Set<string>): Promise<LoadedExtensions> {
  const tools: Tool<never>[] = [];
  const reports: ExtensionReport[] = [];
  const taken = new Set<string>();

  const sources = [
    { scope: 'global' as const, dir: join(configDir(), 'extensions') },
    { scope: 'project' as const, dir: resolve(cwd, PROJECT_EXTENSIONS) },
  ];

  for (const { scope, dir } of sources) {
    for (const file of await modulesIn(dir)) {
      const name = basename(file, extname(file));
      if (!NAME.test(name) || name.includes('__')) {
        reports.push({ name, scope, status: 'failed', toolCount: 0, detail: 'unusable name' });
        continue;
      }
      // Global extensions are the user's own files in their own config
      // directory; a project one arrived with the repository.
      if (scope === 'project' && !trusted.has(name)) {
        reports.push({
          name,
          scope,
          status: 'untrusted',
          toolCount: 0,
          detail: EXTENSION_TRUST_NOTE,
        });
        continue;
      }

      let module: ExtensionModule;
      try {
        module = await importExtension(join(dir, file));
      } catch (error) {
        reports.push({ name, scope, status: 'failed', toolCount: 0, detail: describe(error) });
        continue;
      }

      const declared = module.tools ?? [];
      let added = 0;
      let problem: string | undefined;
      for (const tool of declared) {
        try {
          const wrapped = extensionTool(name, tool, taken);
          if (!wrapped) continue;
          tools.push(wrapped);
          added++;
        } catch (error) {
          problem = describe(error);
          break;
        }
      }

      reports.push({
        name,
        scope,
        status: problem ? 'failed' : 'ready',
        toolCount: added,
        ...(problem ? { detail: problem } : {}),
      });
    }
  }

  return { tools, reports };
}

/**
 * One extension-supplied tool, namespaced and put behind the same gate a
 * built-in goes through.
 *
 * Its `readOnly` claim is honoured, unlike an MCP server's: a server is a
 * different party asserting something about itself, whereas an extension is
 * code the user trusted into their own process, where a false claim here is the
 * least of what it could have done at import time.
 */
function extensionTool(
  extension: string,
  tool: ExtensionTool,
  taken: Set<string>,
): Tool<never> | undefined {
  if (typeof tool?.name !== 'string' || !NAME.test(tool.name)) {
    throw new Error(`declared a tool with an unusable name`);
  }
  if (typeof tool.execute !== 'function') {
    throw new Error(`tool "${tool.name}" has no execute()`);
  }

  const name = namespacedName(extension, tool.name);
  if (taken.has(name)) return undefined;
  taken.add(name);

  const readOnly = tool.readOnly === true;
  return defineTool<Record<string, unknown>>({
    name,
    description: `${tool.description || tool.name} (from the "${extension}" extension)`,
    inputSchema: objectSchema(tool.inputSchema),
    readOnly,
    parse: (input) => (typeof input === 'object' && input !== null ? { ...input } : {}),
    ...(readOnly
      ? {}
      : {
          permission: (input, ctx) => ({
            ...(tool.permission?.(input, ctx) ?? {
              tool: 'Extension',
              target: name,
              title: `${tool.name} from the "${extension}" extension`,
              detail: `${name}(${JSON.stringify(input, null, 2)})`,
            }),
            // The rule name and target are earshot's to decide: an extension
            // choosing its own would let it match a rule the user wrote for
            // something else.
            tool: 'Extension',
            target: name,
          }),
        }),
    async execute(input, ctx) {
      const result = (await tool.execute(input, ctx)) as
        | { output?: unknown; isError?: boolean; title?: string }
        | string
        | undefined;
      if (typeof result === 'string') {
        return { output: { type: 'text', value: result }, title: name };
      }
      const output = result?.output;
      return {
        output:
          typeof output === 'object' && output !== null && 'type' in output
            ? (output as { type: 'text'; value: string })
            : { type: 'text', value: String(output ?? '') },
        ...(result?.isError ? { isError: true } : {}),
        title: typeof result?.title === 'string' ? result.title : name,
      };
    },
  }) as unknown as Tool<never>;
}

function objectSchema(schema: unknown): Record<string, unknown> {
  if (typeof schema !== 'object' || schema === null || Array.isArray(schema)) {
    return { type: 'object', properties: {} };
  }
  return { ...(schema as Record<string, unknown>), type: 'object' };
}

async function modulesIn(dir: string): Promise<string[]> {
  const entries = await readdir(dir).catch(() => []);
  return entries.filter((entry) => LOADABLE.has(extname(entry))).sort();
}

async function importExtension(path: string): Promise<ExtensionModule> {
  const imported = (await import(pathToFileURL(path).href)) as { default?: unknown };
  const module = imported.default;
  if (typeof module !== 'object' || module === null || Array.isArray(module)) {
    throw new Error('does not default-export an object');
  }
  const tools = (module as ExtensionModule).tools;
  if (tools !== undefined && !Array.isArray(tools)) throw new Error('"tools" is not an array');
  return module as ExtensionModule;
}

/**
 * Node cannot import TypeScript on every supported version, and the failure it
 * gives is about file extensions rather than about the thing the user did. Said
 * plainly here rather than left for them to decode.
 */
function describe(error: unknown): string {
  const message = (error as Error)?.message ?? String(error);
  if (/Unknown file extension|Cannot find module .*\.ts/.test(message)) {
    return `this runtime cannot import TypeScript directly: ${message}`;
  }
  return message;
}

export { LOCAL_SETTINGS };
