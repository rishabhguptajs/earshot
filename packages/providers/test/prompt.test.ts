import { describe, expect, test } from 'bun:test';
import type { ModelRequest } from '../src/types.ts';
import { toPrompt } from '../src/wire/ai-sdk-prompt.ts';

const req = (messages: ModelRequest['messages'], system?: string): ModelRequest => ({
  modelId: 'm',
  messages,
  ...(system ? { system } : {}),
});

describe('toPrompt', () => {
  test('puts the system prompt first', () => {
    const prompt = toPrompt(
      req([{ role: 'user', content: [{ type: 'text', text: 'hi' }] }], 'be terse'),
    );
    expect(prompt[0]).toEqual({ role: 'system', content: 'be terse' });
  });

  test('replays assistant reasoning metadata back to the provider', () => {
    // The other half of the round-trip the conformance suite captures on the way in.
    const prompt = toPrompt(
      req([
        {
          role: 'assistant',
          content: [
            {
              type: 'reasoning',
              text: 'thought',
              providerMetadata: { openai: { encrypted: 'blob' } },
            },
          ],
        },
      ]),
    );
    expect(prompt[0]).toEqual({
      role: 'assistant',
      content: [
        { type: 'reasoning', text: 'thought', providerOptions: { openai: { encrypted: 'blob' } } },
      ],
    });
  });

  test('tool calls keep their id, name and input', () => {
    const prompt = toPrompt(
      req([
        {
          role: 'assistant',
          content: [
            { type: 'tool_call', toolCallId: 'c1', toolName: 'read', input: { path: 'a.ts' } },
          ],
        },
      ]),
    );
    expect(prompt[0]).toEqual({
      role: 'assistant',
      content: [{ type: 'tool-call', toolCallId: 'c1', toolName: 'read', input: { path: 'a.ts' } }],
    });
  });

  test('tool results map onto the tool role', () => {
    const prompt = toPrompt(
      req([
        {
          role: 'tool',
          content: [
            {
              type: 'tool_result',
              toolCallId: 'c1',
              toolName: 'read',
              output: { type: 'text', value: 'file body' },
            },
          ],
        },
      ]),
    );
    expect(prompt[0]).toEqual({
      role: 'tool',
      content: [
        {
          type: 'tool-result',
          toolCallId: 'c1',
          toolName: 'read',
          output: { type: 'text', value: 'file body' },
        },
      ],
    });
  });

  test('failed tool results are marked as errors, not passed off as output', () => {
    const prompt = toPrompt(
      req([
        {
          role: 'tool',
          content: [
            {
              type: 'tool_result',
              toolCallId: 'c1',
              toolName: 'bash',
              isError: true,
              output: { type: 'text', value: 'exit 1' },
            },
          ],
        },
      ]),
    );
    const content = prompt[0]?.role === 'tool' ? prompt[0].content[0] : undefined;
    expect(content?.type === 'tool-result' && content.output).toEqual({
      type: 'error-text',
      value: 'exit 1',
    });
  });

  test('base64 images inline, https images stay references', () => {
    const prompt = toPrompt(
      req([
        {
          role: 'user',
          content: [
            { type: 'image', data: 'aGVsbG8=', mediaType: 'image/png' },
            { type: 'image', data: 'https://example.com/a.png', mediaType: 'image/png' },
          ],
        },
      ]),
    );
    const content = prompt[0]?.role === 'user' ? prompt[0].content : [];
    expect(content[0]).toMatchObject({ data: { type: 'data', data: 'aGVsbG8=' } });
    expect(content[1]).toMatchObject({ data: { type: 'url' } });
  });

  test('drops messages that would serialise to empty content', () => {
    expect(toPrompt(req([{ role: 'assistant', content: [] }]))).toEqual([]);
  });
});
