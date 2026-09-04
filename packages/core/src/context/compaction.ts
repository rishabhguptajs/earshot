import type { Message } from '@earshot/providers';
import { estimateTokens } from './shapers.ts';

export interface CompactionPolicy {
  /** Fraction of the context window at which compaction runs. */
  threshold: number;
  /** Turns kept verbatim after the summary. A turn is one user or assistant message. */
  keepRecentMessages: number;
}

export const DEFAULT_COMPACTION_POLICY: CompactionPolicy = {
  threshold: 0.8,
  keepRecentMessages: 8,
};

export interface CompactionInput {
  messages: Message[];
  system: string;
  contextWindow: number;
  policy?: CompactionPolicy;
  /** Open todos, carried across the cut because they are the unfinished work. */
  todos?: string[];
  /** Files the session has touched, carried for the same reason. */
  filesTouched?: string[];
  /** Writes the summary. The agent passes one that calls the model. */
  summarize: (messages: Message[]) => Promise<string>;
}

export interface CompactionResult {
  /** What to send on this request. */
  messages: Message[];
  /** The summary text, for the `summary` session entry and for the status line. */
  summary: string;
  /** How many messages the summary stands in for. */
  replaced: number;
}

export function shouldCompact(
  messages: Message[],
  system: string,
  contextWindow: number,
  policy: CompactionPolicy = DEFAULT_COMPACTION_POLICY,
): boolean {
  if (contextWindow <= 0) return false;
  return estimateTokens(messages, system) > contextWindow * policy.threshold;
}

/**
 * Indices the history can be cut at without orphaning a tool result.
 *
 * A kept tail that begins with a result whose call was dropped is rejected by
 * every provider, so the cut may only fall where each call in the tail still has
 * its own result there. Index 0 is always valid and is the fallback.
 */
export function safeCutPoints(messages: Message[]): number[] {
  const points: number[] = [];
  for (let cut = 0; cut < messages.length; cut++) {
    const calls = new Set<string>();
    let orphan = false;
    for (const message of messages.slice(cut)) {
      for (const part of message.content) {
        if (part.type === 'tool_call') calls.add(part.toolCallId);
        if (part.type === 'tool_result' && !calls.has(part.toolCallId)) orphan = true;
      }
      if (orphan) break;
    }
    if (!orphan) points.push(cut);
  }
  return points;
}

/**
 * Replaces the old part of the history with a model-written summary.
 *
 * The caller decides what to do with the result: the agent sends
 * `result.messages` and appends a `summary` entry to the session, which records
 * what the summary replaced without removing any of it from the file. The
 * transcript on disk stays complete; only the request shrinks.
 */
export async function compact(input: CompactionInput): Promise<CompactionResult | undefined> {
  const policy = input.policy ?? DEFAULT_COMPACTION_POLICY;
  const wanted = Math.max(0, input.messages.length - policy.keepRecentMessages);
  // The largest safe cut no later than the one we wanted, so a batch that
  // straddles the boundary is kept whole rather than truncated.
  const cut = safeCutPoints(input.messages)
    .filter((point) => point <= wanted)
    .at(-1);
  if (cut === undefined || cut === 0) return undefined;

  const summary = await input.summarize(input.messages.slice(0, cut));
  const carried = [
    summary.trim(),
    section('Open todos', input.todos),
    section('Files touched so far', input.filesTouched),
  ]
    .filter((part) => part !== '')
    .join('\n\n');

  const preamble: Message = {
    role: 'user',
    content: [
      {
        type: 'text',
        text:
          `<context-summary>\nThe earlier part of this session was summarised to fit the ` +
          `context window. It is a summary, not a transcript: if a detail matters, read the ` +
          `file rather than trusting a recollection of it.\n\n${carried}\n</context-summary>`,
      },
    ],
  };

  return {
    messages: [preamble, ...input.messages.slice(cut)],
    summary: carried,
    replaced: cut,
  };
}

function section(title: string, items?: string[]): string {
  if (!items?.length) return '';
  return `${title}:\n${items.map((item) => `- ${item}`).join('\n')}`;
}

/** The instruction the summarising call is given. */
export const SUMMARY_PROMPT =
  'Summarise the conversation so far for your own use after the earlier messages are ' +
  'dropped. Write it as notes to yourself, not as a report to the user. Cover: what the ' +
  'user asked for and any constraints or preferences they stated verbatim; decisions made ' +
  'and why; what has been changed, file by file; what is still unfinished; anything that ' +
  'failed or is unverified. Preserve exact names, paths and commands. Do not congratulate ' +
  'anyone and do not claim anything was verified unless the transcript shows it was.';
