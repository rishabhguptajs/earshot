import { EventEmitter } from 'node:events';
import type { ReactElement } from 'react';
import type { Suite } from '../../../scripts/bench/cases/session.ts';
import type { BenchCase } from '../../../scripts/bench/runner.ts';

/**
 * Ink decides at module-evaluation time whether it is running in CI, and in CI
 * it writes only <Static> output and never the live region. A benchmark that
 * measured the live region under that setting would time a no-op and report an
 * improvement. Clearing the variables before Ink loads is why these imports are
 * dynamic and must stay dynamic - a static import is hoisted above the deletion.
 */
delete process.env.CI;
delete process.env.CONTINUOUS_INTEGRATION;
const { Box, Text, render } = await import('ink');
const { Markdown } = await import('../src/components/markdown.tsx');
const { DiffView } = await import('../src/components/diff.tsx');
const { StatusLine } = await import('../src/components/status.tsx');

/** Stands in for a terminal, and discards rather than accumulating: a benchmark
 * that appended every frame to a string would be measuring string growth by the
 * last iteration, not rendering. */
class NullStdout extends EventEmitter {
  columns = 100;
  rows = 30;
  readonly isTTY = true;
  write(): boolean {
    return true;
  }
}

const PROSE = Array.from(
  { length: 60 },
  (_, i) =>
    `## Section ${i}\n\nSome **bold** prose with \`inline code\` and a [link](https://example.com).\n\n- point one\n- point two\n\n\`\`\`ts\nconst x: number = ${i};\n\`\`\`\n`,
).join('\n');

/** Built once, with stable ids: a fresh array per iteration would have the
 * benchmark measuring its own fixture construction alongside the render. */
const TURNS = Array.from({ length: 40 }, (_, i) => ({
  id: `turn-${i}`,
  prompt: `> turn ${i}`,
  answer: `Answer ${i} with **emphasis** and \`code\`.`,
}));

const DIFF = [
  '--- a/src/agent.ts',
  '+++ b/src/agent.ts',
  ...Array.from({ length: 400 }, (_, i) =>
    i % 3 === 0
      ? `-const before${i} = ${i};`
      : i % 3 === 1
        ? `+const after${i} = ${i};`
        : ` const same${i} = ${i};`,
  ),
].join('\n');

function mount(node: ReactElement) {
  const instance = render(node, {
    stdout: new NullStdout() as unknown as NodeJS.WriteStream,
    // Ink's own frame throttling would otherwise coalesce renders and make the
    // measured cost depend on wall-clock timing rather than on the tree.
    patchConsole: false,
  });
  instance.unmount();
  instance.cleanup();
}

export function renderingCases(): Suite {
  return {
    cleanup: async () => {},
    cases: [
      {
        name: 'render/markdown',
        surface: 'rendering',
        // Every assistant message goes through this on its way into Static.
        what: 'mount a 60-section markdown answer',
        iterations: 20,
        run: () => mount(<Markdown text={PROSE} />),
      },
      {
        name: 'render/diff',
        surface: 'rendering',
        what: 'mount a 400-line diff view',
        iterations: 20,
        run: () => mount(<DiffView diff={DIFF} />),
      },
      {
        name: 'render/status-line',
        surface: 'rendering',
        // The live region redraws this on every token, so it is the one
        // component whose cost is multiplied by the length of a response.
        what: 'mount the status line',
        run: () =>
          mount(
            <StatusLine
              model="anthropic/claude-opus-5"
              mode="ask"
              costUsd={1.2345}
              todos={[
                { content: 'restore the milestone', status: 'completed' },
                { content: 'record baselines', status: 'in_progress' },
                { content: 'crash recovery', status: 'pending' },
              ]}
              busy
              queued={2}
              context={{ tokens: 120_000, window: 200_000 }}
              compacted={14}
            />,
          ),
      },
      {
        name: 'render/scrollback',
        surface: 'rendering',
        what: 'mount 40 stacked completed-turn blocks',
        iterations: 10,
        run: () =>
          mount(
            <Box flexDirection="column">
              {TURNS.map((turn) => (
                <Box key={turn.id} flexDirection="column">
                  <Text>{turn.prompt}</Text>
                  <Markdown text={turn.answer} />
                </Box>
              ))}
            </Box>,
          ),
      },
    ] satisfies BenchCase[],
  };
}
