import { type AcpSessionFactory, runAcpServer } from '@earshot/acp';
import {
  createSession,
  DEFAULT_MODEL,
  isPermissionMode,
  listSessions,
  type PermissionMode,
} from '@earshot/core';
import type { ParsedArgs } from '../args.ts';
import { startExtensions } from '../extensions/index.ts';

export async function acpCommand(args: ParsedArgs): Promise<number> {
  const requested = args.flags['permission-mode'];
  let mode: PermissionMode | undefined;
  if (typeof requested === 'string') {
    if (!isPermissionMode(requested)) {
      process.stderr.write(`"${requested}" is not a permission mode\n`);
      return 2;
    }
    mode = requested;
  }

  const requestedModel = typeof args.flags.model === 'string' ? args.flags.model : undefined;
  const model = requestedModel ?? DEFAULT_MODEL;
  const apiKey = typeof args.flags['api-key'] === 'string' ? args.flags['api-key'] : undefined;
  const sessionFactory: AcpSessionFactory = async ({ cwd, resumeSessionId }) => {
    const extensions = await startExtensions(cwd);
    let resume: { path: string } | undefined;
    if (resumeSessionId) {
      const found = (await listSessions(cwd)).find((session) => session.id === resumeSessionId);
      if (!found) {
        await extensions.close();
        throw new Error(`no session "${resumeSessionId}" for ${cwd}`);
      }
      resume = { path: found.path };
    }
    try {
      return await createSession({
        cwd,
        ...(requestedModel ? { model: requestedModel } : {}),
        extraTools: extensions.tools,
        problems: extensions.problems,
        onDispose: () => extensions.close(),
        ...(mode ? { mode } : {}),
        ...(apiKey ? { apiKey } : {}),
        ...(resume ? { resume } : {}),
      });
    } catch (error) {
      await extensions.close();
      throw error;
    }
  };

  await runAcpServer({ model, sessionFactory });
  return 0;
}
