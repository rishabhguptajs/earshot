import type {
  LanguageModelV4FilePart,
  LanguageModelV4Message,
  LanguageModelV4Prompt,
  LanguageModelV4ReasoningPart,
  LanguageModelV4TextPart,
  LanguageModelV4ToolCallPart,
  LanguageModelV4ToolResultOutput,
  LanguageModelV4ToolResultPart,
  SharedV4FileData,
} from '@ai-sdk/provider';
import type {
  ImagePart,
  Message,
  ModelRequest,
  ToolResultOutput,
  ToolResultPart,
} from '../types.ts';

/**
 * Unified messages -> LanguageModelV4 prompt.
 *
 * Our `providerMetadata` maps onto the spec's per-part `providerOptions`, which is
 * how round-trip-critical data survives: OpenAI's encrypted reasoning payloads and
 * Gemini's thought signatures are read back off the assistant parts we stored and
 * handed straight back to the provider untouched.
 */
export function toPrompt(req: ModelRequest): LanguageModelV4Prompt {
  const prompt: LanguageModelV4Prompt = [];
  if (req.system) prompt.push({ role: 'system', content: req.system });
  for (const message of req.messages) {
    prompt.push(...convertMessage(message));
  }
  return prompt;
}

function convertMessage(message: Message): LanguageModelV4Message[] {
  const opts = (meta: Message['providerMetadata']) => (meta ? { providerOptions: meta } : {});

  switch (message.role) {
    case 'system': {
      const text = message.content
        .filter((p) => p.type === 'text')
        .map((p) => p.text)
        .join('\n');
      return text ? [{ role: 'system', content: text }] : [];
    }

    case 'user': {
      const content: Array<LanguageModelV4TextPart | LanguageModelV4FilePart> = [];
      for (const part of message.content) {
        if (part.type === 'text') {
          content.push({ type: 'text', text: part.text, ...opts(part.providerMetadata) });
        } else if (part.type === 'image') {
          content.push(imageToFilePart(part));
        }
      }
      return content.length ? [{ role: 'user', content }] : [];
    }

    case 'assistant': {
      const content: Array<
        LanguageModelV4TextPart | LanguageModelV4ReasoningPart | LanguageModelV4ToolCallPart
      > = [];
      for (const part of message.content) {
        switch (part.type) {
          case 'text':
            content.push({ type: 'text', text: part.text, ...opts(part.providerMetadata) });
            break;
          case 'reasoning':
            content.push({ type: 'reasoning', text: part.text, ...opts(part.providerMetadata) });
            break;
          case 'tool_call':
            content.push({
              type: 'tool-call',
              toolCallId: part.toolCallId,
              toolName: part.toolName,
              input: part.input,
              ...opts(part.providerMetadata),
            });
            break;
          default:
            break;
        }
      }
      return content.length ? [{ role: 'assistant', content }] : [];
    }

    case 'tool': {
      const content = message.content
        .filter((p): p is ToolResultPart => p.type === 'tool_result')
        .map(toToolResultPart);
      return content.length ? [{ role: 'tool', content }] : [];
    }
  }
}

function toToolResultPart(part: ToolResultPart): LanguageModelV4ToolResultPart {
  return {
    type: 'tool-result',
    toolCallId: part.toolCallId,
    toolName: part.toolName,
    output: toToolOutput(part.output, part.isError ?? false),
    ...(part.providerMetadata ? { providerOptions: part.providerMetadata } : {}),
  };
}

function toToolOutput(output: ToolResultOutput, isError: boolean): LanguageModelV4ToolResultOutput {
  switch (output.type) {
    case 'text':
      return isError
        ? { type: 'error-text', value: output.value }
        : { type: 'text', value: output.value };
    case 'json':
      return isError
        ? { type: 'error-json', value: output.value as never }
        : { type: 'json', value: output.value as never };
    case 'content':
      return {
        type: 'content',
        value: output.value.map((p) =>
          p.type === 'text'
            ? { type: 'text' as const, text: p.text }
            : { type: 'file' as const, mediaType: p.mediaType, data: toFileData(p.data) },
        ),
      };
  }
}

/** Base64 payloads pass through as data; https references stay references so the
 *  provider fetches them itself rather than us inlining megabytes into the prompt. */
function toFileData(data: string): SharedV4FileData {
  return /^https?:\/\//i.test(data) ? { type: 'url', url: new URL(data) } : { type: 'data', data };
}

function imageToFilePart(part: ImagePart): LanguageModelV4FilePart {
  return {
    type: 'file',
    mediaType: part.mediaType,
    data: toFileData(part.data),
    ...(part.providerMetadata ? { providerOptions: part.providerMetadata } : {}),
  };
}
