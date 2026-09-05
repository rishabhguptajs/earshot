import { afterEach, describe, expect, test } from 'bun:test';

const children: Bun.Subprocess[] = [];

afterEach(() => {
  for (const child of children) child.kill();
  children.length = 0;
});

describe('earshot acp over stdio', () => {
  test('answers an ACP v1 initialize request as newline-delimited JSON', async () => {
    const child = Bun.spawn(['bun', 'packages/cli/src/main.ts', 'acp'], {
      cwd: process.cwd(),
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
    });
    children.push(child);
    child.stdin.write(
      `${JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: 1, clientCapabilities: {} },
      })}\n`,
    );
    child.stdin.flush();

    const reader = child.stdout.getReader();
    const { value } = await reader.read();
    const line = new TextDecoder().decode(value).trim();
    const response = JSON.parse(line);

    expect(response.id).toBe(1);
    expect(response.result.protocolVersion).toBe(1);
    expect(response.result.agentCapabilities).toEqual({
      loadSession: true,
      promptCapabilities: { image: true },
    });
  });
});
