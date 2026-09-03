import { Box, Text } from 'ink';
import { theme } from '../theme.ts';

/** Beyond this a diff is summarised; a 900-line hunk is not read, it is scrolled past. */
const MAX_LINES = 60;

export function DiffView({ diff, maxLines = MAX_LINES }: { diff: string; maxLines?: number }) {
  const lines = diff.split('\n');
  // The `---`/`+++` header repeats the filename the caller has already shown.
  const body = lines.filter((line) => !line.startsWith('---') && !line.startsWith('+++'));
  const shown = body.slice(0, maxLines);
  const hidden = body.length - shown.length;

  return (
    <Box flexDirection="column">
      {shown.map((line, index) => (
        // A diff line has no identity beyond its position, and duplicate lines in
        // one hunk are ordinary. The list is only ever replaced wholesale - never
        // reordered or spliced - so a positional key is the correct one here.
        // biome-ignore lint/suspicious/noArrayIndexKey: position is the identity
        <Text key={index} color={colorFor(line)} wrap="truncate-end">
          {line === '' ? ' ' : line}
        </Text>
      ))}
      {hidden > 0 && (
        <Text color={theme.muted}>
          {'  '}
          ... {hidden} more lines
        </Text>
      )}
    </Box>
  );
}

function colorFor(line: string): string {
  if (line.startsWith('+')) return theme.added;
  if (line.startsWith('-')) return theme.removed;
  if (line.startsWith('@@')) return theme.hunk;
  return theme.muted;
}

/** One line of counts, for a collapsed edit. */
export function diffStat(diff: string): string {
  let added = 0;
  let removed = 0;
  for (const line of diff.split('\n')) {
    if (line.startsWith('+') && !line.startsWith('+++')) added++;
    if (line.startsWith('-') && !line.startsWith('---')) removed++;
  }
  return `+${added} -${removed}`;
}
