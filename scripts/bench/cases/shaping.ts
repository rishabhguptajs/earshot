import {
  DEFAULT_SHAPER_OPTIONS,
  estimateTokens,
  shapeMessages,
} from '../../../packages/core/src/index.ts';
import type { Message } from '../../../packages/providers/src/index.ts';
import type { BenchCase } from '../runner.ts';

/**
 * Shaping runs before every model call, so its cost is paid once per turn and
 * grows with the transcript rather than with the change being made. That is the
 * shape of cost worth watching: a constant factor here is invisible, and a
 * factor of transcript length is what makes a long session feel slow.
 */
function transcript(turns: number, resultChars: number): Message[] {
  const messages: Message[] = [];
  for (let i = 0; i < turns; i++) {
    messages.push({ role: 'user', content: [{ type: 'text', text: `step ${i}` }] });
    messages.push({
      role: 'assistant',
      content: [
        {
          type: 'tool_call',
          toolCallId: `call-${i}`,
          toolName: 'read',
          input: { path: `src/f${i}.ts` },
        },
      ],
    });
    messages.push({
      role: 'tool',
      content: [
        {
          type: 'tool_result',
          toolCallId: `call-${i}`,
          toolName: 'read',
          output: [{ type: 'text', text: 'x'.repeat(resultChars) }],
        },
      ],
    });
  }
  return messages;
}

export function shapingCases(): BenchCase[] {
  // Under the default keepDetailedBatches, a short transcript exercises the cap
  // path only and a long one exercises the stub path for most of its results.
  // Measuring one of them would hide whichever shaper the other one dominates.
  const short = transcript(10, 4_000);
  const long = transcript(400, 4_000);
  // Wider than maxResultChars, so every result takes the truncating branch.
  const heavy = transcript(60, 60_000);

  return [
    {
      name: 'shape/short-transcript',
      surface: 'shaping',
      what: '30 messages, results under the cap',
      repeats: 200,
      run: () => shapeMessages(short, DEFAULT_SHAPER_OPTIONS),
    },
    {
      name: 'shape/long-transcript',
      surface: 'shaping',
      what: '1200 messages, most results stubbed',
      iterations: 20,
      repeats: 20,
      run: () => shapeMessages(long, DEFAULT_SHAPER_OPTIONS),
    },
    {
      name: 'shape/oversized-results',
      surface: 'shaping',
      what: '180 messages, every result over the 20k cap',
      iterations: 20,
      repeats: 100,
      run: () => shapeMessages(heavy, DEFAULT_SHAPER_OPTIONS),
    },
    {
      name: 'shape/estimate-tokens',
      surface: 'shaping',
      // Drawn into the status line on every render, not just once per call, so
      // it is on a far hotter path than the shapers it sits next to.
      what: 'token estimate over a 1200-message transcript',
      repeats: 50,
      run: () => estimateTokens(long),
    },
  ];
}
