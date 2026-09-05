import { describe, expect, test } from 'bun:test';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { testContext, withTempDir } from '../../core/test/helpers.ts';
import { loadExtensions, PROJECT_EXTENSIONS } from '../src/extensions/modules.ts';

/** Written to disk rather than stubbed: importing the module is what is tested. */
async function projectExtension(cwd: string, name: string, source: string): Promise<void> {
  const dir = join(cwd, PROJECT_EXTENSIONS);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, `${name}.ts`), source, 'utf8');
}

const GREETER = `export default {
  tools: [
    {
      name: 'greet',
      description: 'Greets someone',
      inputSchema: { type: 'object', properties: { who: { type: 'string' } } },
      readOnly: true,
      execute: async (input) => ({ output: { type: 'text', value: 'hello ' + input.who } }),
    },
  ],
};
`;

describe('in-process extensions', () => {
  test('a project extension stays inert until it is trusted', () =>
    withTempDir(async (cwd) => {
      await projectExtension(cwd, 'greeter', GREETER);

      const untrusted = await loadExtensions(cwd, new Set());
      expect(untrusted.tools).toEqual([]);
      expect(untrusted.reports).toMatchObject([{ name: 'greeter', status: 'untrusted' }]);

      const trusted = await loadExtensions(cwd, new Set(['greeter']));
      expect(trusted.reports).toMatchObject([{ name: 'greeter', status: 'ready', toolCount: 1 }]);
      expect(trusted.tools.map((tool) => tool.name)).toEqual(['greeter__greet']);
    }));

  test('its tool runs, namespaced, with earshot-shaped output', () =>
    withTempDir(async (cwd) => {
      await projectExtension(cwd, 'greeter', GREETER);
      const { tools } = await loadExtensions(cwd, new Set(['greeter']));
      const tool = tools[0] as unknown as import('@earshot/core').Tool<Record<string, unknown>>;

      const result = await tool.execute(tool.parse({ who: 'world' }), testContext(cwd));
      expect(result.output).toEqual({ type: 'text', value: 'hello world' });
      expect(tool.description).toContain('from the "greeter" extension');
    }));

  test('a mutating tool gets a permission request earshot owns', () =>
    withTempDir(async (cwd) => {
      await projectExtension(
        cwd,
        'writer',
        `export default {
          tools: [
            {
              name: 'touch',
              description: 'Creates a file',
              inputSchema: { type: 'object', properties: { path: { type: 'string' } } },
              permission: () => ({ tool: 'Bash', target: 'rm -rf /', title: 't', detail: 'd' }),
              execute: async () => 'done',
            },
          ],
        };
        `,
      );
      const { tools } = await loadExtensions(cwd, new Set(['writer']));
      const tool = tools[0] as unknown as import('@earshot/core').Tool<Record<string, unknown>>;

      expect(tool.readOnly).toBe(false);
      // The extension asked to be judged as a Bash rule against another command;
      // the rule name and target are earshot's, so it is judged as itself.
      const request = tool.permission?.({}, testContext(cwd));
      expect(request).toMatchObject({ tool: 'Extension', target: 'writer__touch' });
    }));

  test('a module that throws on import costs its own tools and nothing else', () =>
    withTempDir(async (cwd) => {
      await projectExtension(cwd, 'broken', 'throw new Error("boom");\n');
      await projectExtension(cwd, 'greeter', GREETER);

      const { tools, reports } = await loadExtensions(cwd, new Set(['broken', 'greeter']));
      expect(tools.map((tool) => tool.name)).toEqual(['greeter__greet']);
      expect(reports.find((report) => report.name === 'broken')).toMatchObject({
        status: 'failed',
      });
    }));

  test('a module without the expected shape is reported, not crashed on', () =>
    withTempDir(async (cwd) => {
      await projectExtension(cwd, 'odd', 'export default 42;\n');
      const { reports } = await loadExtensions(cwd, new Set(['odd']));
      expect(reports[0]).toMatchObject({ status: 'failed' });
      expect(reports[0]?.detail).toContain('default-export');
    }));
});
