import type { Message, MessagePart, ToolResultPart } from '@earshot/providers';

/**
 * What runs over the message list before each model call, cheapest first.
 *
 * Every shaper is a pure function from messages to messages. Nothing here may
 * touch `Agent.history`: history is append-only because Anthropic rejects a
 * request containing edited thinking blocks, so shaping produces the array sent
 * on this one request and leaves the transcript alone.
 */
export interface ShaperOptions {
  /** Longest a single tool result may be before it is truncated. */
  maxResultChars: number;
  /** Tool results from batches older than this are reduced to a stub. */
  keepDetailedBatches: number;
  /** Longest a stub may be. */
  stubChars: number;
}

export const DEFAULT_SHAPER_OPTIONS: ShaperOptions = {
  maxResultChars: 20_000,
  keepDetailedBatches: 6,
  stubChars: 200,
};

/**
 * Rough token count.
 *
 * Four characters per token is wrong for every tokenizer and close enough for
 * all three uses here - deciding when to compact, drawing a percentage, and
 * ordering shapers. Being exact would mean shipping a tokenizer per provider to
 * make a progress bar one percent more accurate.
 */
export function estimateTokens(messages: Message[], system = ''): number {
  let chars = system.length;
  for (const message of messages) {
    for (const part of message.content) chars += partChars(part);
    // Role, delimiters and tool-call framing the provider adds around each part.
    chars += 16;
  }
  return Math.ceil(chars / 4);
}

function partChars(part: MessagePart): number {
  switch (part.type) {
    case 'text':
    case 'reasoning':
      return part.text.length;
    case 'tool_call':
      return part.toolName.length + JSON.stringify(part.input ?? null).length;
    case 'tool_result':
      return part.toolName.length + outputText(part).length;
    // An image costs tokens by dimension, which we do not have here. A flat
    // estimate keeps it from reading as free, which is the failure that matters.
    case 'image':
      return 4000;
    default:
      return 0;
  }
}

/** The text of a tool result, whatever shape the output took. */
export function outputText(part: ToolResultPart): string {
  const { output } = part;
  switch (output.type) {
    case 'text':
      return output.value;
    case 'json':
      return JSON.stringify(output.value);
    case 'content':
      return output.value
        .map((item) => (item.type === 'text' ? item.text : `[${item.mediaType}]`))
        .join('\n');
    default:
      return '';
  }
}

function withText(part: ToolResultPart, text: string): ToolResultPart {
  return { ...part, output: { type: 'text', value: text } };
}

/**
 * Caps one oversized result rather than dropping it.
 *
 * The head and the tail are kept and the middle is elided: a 200k-line grep is
 * useless in full, but its first hits and the total at the end are exactly what
 * the model needs, and keeping only the head loses the summary line that most
 * tools print last.
 */
export function capResults(messages: Message[], options: ShaperOptions): Message[] {
  return messages.map((message) => {
    if (message.role !== 'tool') return message;
    let changed = false;
    const content = message.content.map((part) => {
      if (part.type !== 'tool_result') return part;
      const text = outputText(part);
      if (text.length <= options.maxResultChars) return part;
      changed = true;
      const half = Math.floor((options.maxResultChars - 80) / 2);
      const dropped = text.length - half * 2;
      return withText(
        part,
        `${text.slice(0, half)}\n\n... ${dropped} characters elided by earshot ...\n\n${text.slice(-half)}`,
      );
    });
    return changed ? { ...message, content } : message;
  });
}

/**
 * Replaces the body of older tool results with a one-line stub.
 *
 * The result *part* stays: a provider rejects the next request if an assistant
 * tool call has no matching result, so pruning may only shrink a result, never
 * remove it. Recent batches are left intact because that is the work the model
 * is still reasoning about.
 */
export function pruneResults(messages: Message[], options: ShaperOptions): Message[] {
  const toolMessages = messages.filter((message) => message.role === 'tool');
  const cutoff = toolMessages.length - options.keepDetailedBatches;
  if (cutoff <= 0) return messages;

  let seen = 0;
  return messages.map((message) => {
    if (message.role !== 'tool') return message;
    const index = seen++;
    if (index >= cutoff) return message;

    let changed = false;
    const content = message.content.map((part) => {
      if (part.type !== 'tool_result') return part;
      const text = outputText(part);
      if (text.length <= options.stubChars) return part;
      changed = true;
      const first = text.split('\n', 1)[0]?.slice(0, options.stubChars) ?? '';
      return withText(
        part,
        `[${part.toolName} result from an earlier step, ${text.length} characters, elided]${
          first ? `\n${first}` : ''
        }`,
      );
    });
    return changed ? { ...message, content } : message;
  });
}

/** Runs the cheap shapers in order. Compaction is separate: it costs a model call. */
export function shapeMessages(
  messages: Message[],
  options: ShaperOptions = DEFAULT_SHAPER_OPTIONS,
): Message[] {
  return pruneResults(capResults(messages, options), options);
}
