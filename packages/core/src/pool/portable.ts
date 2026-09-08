import type { Message, MessagePart, ProviderMetadata } from '@earshot/providers';

/**
 * Makes a transcript safe to replay to a different provider.
 *
 * `providerMetadata` is round-tripped verbatim on purpose: Anthropic thinking
 * blocks, OpenAI encrypted reasoning and Gemini thought signatures are signed or
 * encrypted by the provider that issued them, and altering one breaks the next
 * request. That rule holds within a conversation with one provider. Sending
 * another provider's blobs to a *different* one is the case it does not cover -
 * they are meaningless there at best, and rejected at worst.
 *
 * So on a swap, and only on a swap, each message keeps the target provider's own
 * metadata verbatim and drops everybody else's. Reasoning parts whose text is
 * empty go too: an empty part is a pure opaque blob, and without the blob there
 * is nothing left to replay.
 *
 * This is lossy, and deliberately so. The alternative is a request the new
 * provider rejects, which loses the whole turn instead of some hidden thinking.
 */
export function portableFor(providerId: string, messages: readonly Message[]): Message[] {
  return messages.map((message) => portableMessage(providerId, message));
}

function portableMessage(providerId: string, message: Message): Message {
  const content: MessagePart[] = [];
  for (const part of message.content) {
    // A reasoning part that carried only an opaque blob has nothing to say once
    // the blob is gone; keeping an empty one would send a blank thought.
    if (part.type === 'reasoning' && part.text.trim() === '') continue;
    const metadata = keepOwn(providerId, part.providerMetadata);
    const { providerMetadata: _dropped, ...rest } = part;
    content.push((metadata ? { ...rest, providerMetadata: metadata } : rest) as MessagePart);
  }

  const metadata = keepOwn(providerId, message.providerMetadata);
  const { providerMetadata: _dropped, ...rest } = message;
  return { ...rest, content, ...(metadata ? { providerMetadata: metadata } : {}) };
}

/** `providerMetadata` is namespaced by provider id, which is what makes this possible. */
function keepOwn(
  providerId: string,
  metadata: ProviderMetadata | undefined,
): ProviderMetadata | undefined {
  if (!metadata) return undefined;
  const own = metadata[providerId];
  return own ? { [providerId]: own } : undefined;
}

/** Whether a swap to `providerId` would change anything about these messages. */
export function needsRewrite(providerId: string, messages: readonly Message[]): boolean {
  for (const message of messages) {
    if (foreign(providerId, message.providerMetadata)) return true;
    for (const part of message.content) {
      if (part.type === 'reasoning' && part.text.trim() === '') return true;
      if (foreign(providerId, part.providerMetadata)) return true;
    }
  }
  return false;
}

const foreign = (providerId: string, metadata: ProviderMetadata | undefined): boolean =>
  metadata !== undefined && Object.keys(metadata).some((key) => key !== providerId);
