import type { Message, ToolCallPart, ToolResultPart } from '@earshot/providers';

/**
 * Repairing a transcript that a crash left mid-turn.
 *
 * The loop already covers the interruptions it can see: `runCalls` fills every
 * empty slot with an error result before the tool message is appended, so an
 * abort - Ctrl-C, a budget stop, a failed step - never reaches disk half-written.
 * What it cannot cover is the process not surviving to do that. Messages are
 * persisted as they are produced, so between the assistant message carrying the
 * tool calls and the tool message carrying their results there is a window in
 * which a SIGKILL, a power loss or an OOM leaves calls with no answer.
 *
 * That file is not corrupt and reads back fine. It is invalid as a *request*:
 * every tool call must have a result part or the next call fails at the
 * provider, so `--resume` on such a session breaks on the first turn, before
 * the user has done anything. Repair closes that.
 *
 * The repair is an append. History is append-only because Anthropic rejects
 * edited thinking blocks, and because a transcript that rewrites itself cannot
 * be trusted as a record of what happened - so the results synthesised here go
 * into a new entry with a normal parent, visible in `/tree` like any other. The
 * abandoned turn stays on disk exactly as the crash left it.
 */
const REPAIR_TEXT =
  'No result was recorded for this call: earshot exited before the tool finished. ' +
  'The call may or may not have run, so treat its effect as unknown and check ' +
  'the current state rather than assuming either outcome.';

/**
 * Tool calls in `messages` that no later message answers.
 *
 * The whole branch is scanned rather than only its last pair, because a result
 * may legitimately arrive in a message well after the call - and because a
 * session resumed twice must not re-repair calls the first repair answered.
 */
export function unresolvedToolCalls(messages: Message[]): ToolCallPart[] {
  const answered = new Set<string>();
  const calls: ToolCallPart[] = [];

  for (const message of messages) {
    for (const part of message.content) {
      if (part.type === 'tool_call') calls.push(part);
      else if (part.type === 'tool_result') answered.add(part.toolCallId);
    }
  }
  return calls.filter((call) => !answered.has(call.toolCallId));
}

/**
 * The message that answers `calls`, in the order they were emitted.
 *
 * Results are marked `isError` and say what is not known rather than claiming
 * the call failed: a process killed after a `write` completed leaves the file
 * written, and a repair that reported "this did not run" would be a lie the
 * model would then act on.
 */
export function repairMessage(calls: ToolCallPart[]): Message {
  const content: ToolResultPart[] = calls.map((call) => ({
    type: 'tool_result',
    toolCallId: call.toolCallId,
    toolName: call.toolName,
    output: { type: 'text', value: REPAIR_TEXT },
    isError: true,
  }));
  return { role: 'tool', content };
}
