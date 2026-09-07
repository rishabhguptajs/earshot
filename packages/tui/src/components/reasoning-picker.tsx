import type { ReasoningEffort } from '@earshot/providers';
import { Box, Text, useInput } from 'ink';
import { useState } from 'react';
import { theme } from '../theme.ts';

const choices = ['auto', 'none', 'low', 'medium', 'high', 'xhigh'] as const;

export function ReasoningPicker({
  current,
  onDone,
  onCancel,
}: {
  current?: ReasoningEffort;
  onDone: (effort: ReasoningEffort | undefined) => void;
  onCancel: () => void;
}) {
  const [cursor, setCursor] = useState(Math.max(0, choices.indexOf(current ?? 'auto')));
  useInput((_input, key) => {
    if (key.escape) return onCancel();
    if (key.upArrow) setCursor((value) => (value <= 0 ? choices.length - 1 : value - 1));
    if (key.downArrow) setCursor((value) => (value >= choices.length - 1 ? 0 : value + 1));
    if (key.return) {
      const selected = choices[cursor] ?? 'auto';
      onDone(selected === 'auto' ? undefined : selected);
    }
  });
  return (
    <Box flexDirection="column">
      <Text>reasoning effort</Text>
      <Box flexDirection="column" marginTop={1}>
        {choices.map((choice, index) => (
          <Text key={choice} color={index === cursor ? theme.user : theme.muted}>
            {index === cursor ? '› ' : '  '}
            {choice}
          </Text>
        ))}
      </Box>
      <Text color={theme.muted}>↑↓ choose · enter select · esc cancel</Text>
    </Box>
  );
}
