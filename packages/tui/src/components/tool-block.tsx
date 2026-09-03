import { Box, Text } from 'ink';
import { theme } from '../theme.ts';
import { DiffView, diffStat } from './diff.tsx';

export interface ToolBlockProps {
  name: string;
  title?: string;
  output?: string;
  isError?: boolean;
  running?: boolean;
  /** Expanded blocks show full output; collapsed ones show a line of summary. */
  expanded?: boolean;
}

/** Output beyond this collapses to a count; the full text is in the transcript. */
const PREVIEW_LINES = 8;

/**
 * One tool call, collapsed by default.
 *
 * A long tool result pushes the conversation off the screen, and the reason
 * someone is reading a coding agent's scrollback is almost never to re-read the
 * contents of a file it opened. What matters is which tool ran, on what, and
 * whether it failed - so that is what a collapsed block shows, and errors are
 * never collapsed.
 */
export function ToolBlock({
  name,
  title,
  output = '',
  isError,
  running,
  expanded,
}: ToolBlockProps) {
  const marker = running ? '·' : isError ? '✗' : '✓';
  const color = isError ? theme.toolError : theme.tool;
  const isDiff = output.includes('\n@@') || output.startsWith('---');

  const lines = output === '' ? [] : output.split('\n');
  // An error is always shown in full: it is the one output the user has to read,
  // and it is the thing the model is about to react to.
  const showAll = expanded || isError;
  const shown = showAll ? lines : lines.slice(0, PREVIEW_LINES);
  const hidden = lines.length - shown.length;

  return (
    <Box flexDirection="column" marginTop={1}>
      <Text color={color}>
        {marker} <Text bold>{name}</Text>
        {title ? <Text color={theme.muted}> {title}</Text> : null}
        {isDiff && !showAll ? <Text color={theme.muted}> {diffStat(output)}</Text> : null}
      </Text>
      {isDiff && showAll ? (
        <Box marginLeft={2}>
          <DiffView diff={output} />
        </Box>
      ) : (
        shown.map((line, index) => (
          // Output lines have no identity beyond position, and this block is
          // replaced wholesale rather than reordered. See DiffView for the same.
          // biome-ignore lint/suspicious/noArrayIndexKey: position is the identity
          <Text key={index} color={theme.muted} wrap="truncate-end">
            {'  '}
            {line}
          </Text>
        ))
      )}
      {hidden > 0 && !isDiff && (
        <Text color={theme.muted}>
          {'  '}
          ... {hidden} more lines
        </Text>
      )}
    </Box>
  );
}
