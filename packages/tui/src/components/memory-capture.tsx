import type { MemoryCandidate } from '@earshot/core';
import { Box, Text } from 'ink';
import { theme } from '../theme.ts';

export interface MemoryCaptureProps {
  candidate: MemoryCandidate;
}

/**
 * A one-line offer, not a modal.
 *
 * Capturing a preference must never interrupt the turn the user just started:
 * a dialog here would make correcting the agent more expensive than letting the
 * mistake stand, which is the opposite of the point. Two keystrokes take it,
 * ignoring it costs nothing, and it disappears with the next prompt.
 */
export function MemoryCapture({ candidate }: MemoryCaptureProps) {
  return (
    <Box marginTop={1}>
      <Text color={theme.accent}>remember </Text>
      <Text>“{candidate.text}”</Text>
      <Text color={theme.muted}>? ctrl+r for this project · ctrl+g everywhere</Text>
    </Box>
  );
}
