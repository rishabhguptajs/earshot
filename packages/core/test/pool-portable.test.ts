import { describe, expect, test } from 'bun:test';
import type { Message } from '@earshot/providers';
import { needsRewrite, portableFor } from '../src/pool/portable.ts';

/**
 * `providerMetadata` is round-tripped verbatim on purpose - thinking blocks and
 * encrypted reasoning are signed by the provider that issued them. That rule is
 * about one provider's conversation with itself. Handing another provider those
 * blobs is the case it does not cover, and the case a pool creates.
 */
describe('making history portable across a swap', () => {
  const history: Message[] = [
    {
      role: 'assistant',
      content: [
        {
          type: 'reasoning',
          text: 'thinking out loud',
          providerMetadata: { anthropic: { signature: 'sig-abc' } },
        },
        {
          type: 'text',
          text: 'the answer',
          providerMetadata: { anthropic: { cacheControl: 'ephemeral' } },
        },
      ],
      providerMetadata: { anthropic: { stopReason: 'end_turn' } },
    },
  ];

  test('another provider’s metadata is dropped', () => {
    const [message] = portableFor('groq', history);
    expect(message?.providerMetadata).toBeUndefined();
    expect(message?.content[0]?.providerMetadata).toBeUndefined();
    expect(message?.content[1]?.providerMetadata).toBeUndefined();
  });

  test('the text itself survives - only the provider’s blobs go', () => {
    const [message] = portableFor('groq', history);
    expect(message?.content.map((part) => part.type)).toEqual(['reasoning', 'text']);
    expect(message?.content[1]).toMatchObject({ type: 'text', text: 'the answer' });
  });

  /**
   * Replaying to the same provider must not touch anything: this is the case
   * where altering a signed block breaks the next request outright.
   */
  test('the target provider’s own metadata is preserved verbatim', () => {
    const [message] = portableFor('anthropic', history);
    expect(message?.providerMetadata).toEqual({ anthropic: { stopReason: 'end_turn' } });
    expect(message?.content[0]?.providerMetadata).toEqual({ anthropic: { signature: 'sig-abc' } });
    expect(needsRewrite('anthropic', history)).toBe(false);
  });

  test('mixed metadata keeps the target’s half and drops the rest', () => {
    const mixed: Message[] = [
      {
        role: 'assistant',
        content: [
          {
            type: 'text',
            text: 'x',
            providerMetadata: { openai: { itemId: 'i-1' }, groq: { keep: 'this' } },
          },
        ],
      },
    ];
    const [message] = portableFor('groq', mixed);
    expect(message?.content[0]?.providerMetadata).toEqual({ groq: { keep: 'this' } });
  });

  /**
   * An empty reasoning part is a pure opaque blob - the provider returned no
   * text, only something to hand back. Without the blob there is nothing left,
   * and sending a blank thought is worse than sending none.
   */
  test('a reasoning part that was only an opaque blob is removed', () => {
    const opaque: Message[] = [
      {
        role: 'assistant',
        content: [
          { type: 'reasoning', text: '', providerMetadata: { openai: { encrypted: 'zzz' } } },
          { type: 'text', text: 'the answer' },
        ],
      },
    ];
    const [message] = portableFor('groq', opaque);
    expect(message?.content.map((part) => part.type)).toEqual(['text']);
  });

  test('tool calls and their results are left alone', () => {
    const withTools: Message[] = [
      {
        role: 'assistant',
        content: [{ type: 'tool_call', toolCallId: 'c1', toolName: 'read', input: { path: 'a' } }],
      },
      {
        role: 'tool',
        content: [
          {
            type: 'tool_result',
            toolCallId: 'c1',
            toolName: 'read',
            output: { type: 'text', value: 'contents' },
          },
        ],
      },
    ];
    expect(portableFor('groq', withTools)).toEqual(withTools);
    expect(needsRewrite('groq', withTools)).toBe(false);
  });

  test('needsRewrite spots foreign metadata and blob-only reasoning', () => {
    expect(needsRewrite('groq', history)).toBe(true);
    expect(
      needsRewrite('groq', [{ role: 'assistant', content: [{ type: 'reasoning', text: '  ' }] }]),
    ).toBe(true);
  });

  test('the input is not mutated', () => {
    const snapshot = structuredClone(history);
    portableFor('groq', history);
    expect(history).toEqual(snapshot);
  });
});
