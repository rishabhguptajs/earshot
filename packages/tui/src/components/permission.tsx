import type { PermissionRequest, PromptChoice } from '@earshot/core';
import { Box, Text, useInput } from 'ink';
import { useState } from 'react';
import { theme } from '../theme.ts';
import { DiffView } from './diff.tsx';

export interface PermissionPromptProps {
  request: PermissionRequest;
  reason: string;
  onChoice: (choice: PromptChoice) => void;
}

interface Option {
  label: string;
  choice: PromptChoice;
  color: string;
}

/**
 * The approval prompt.
 *
 * It renders `request.detail` in full - the actual command, or the actual diff.
 * A prompt that shows a summary is one people learn to approve without reading,
 * which makes the whole gate theatre. Nothing here paraphrases.
 *
 * "Allow once" is first and selected by default. The safe choice being the
 * default matters more than the convenient one, and a user who wants the
 * standing rule has to move to it deliberately.
 */
export function PermissionPrompt({ request, reason, onChoice }: PermissionPromptProps) {
  const [selected, setSelected] = useState(0);

  const options: Option[] = [
    { label: 'Allow once', choice: { kind: 'allow-once' }, color: theme.assistant },
    {
      label: `Always allow ${request.tool}(${truncate(request.target, 40)}) in this project`,
      choice: { kind: 'allow-always', scope: 'project' },
      color: theme.assistant,
    },
    {
      label: 'Deny and tell the agent why',
      choice: { kind: 'deny' },
      color: theme.danger,
    },
  ];

  useInput((input, key) => {
    if (key.upArrow || input === 'k') setSelected((n) => (n + options.length - 1) % options.length);
    else if (key.downArrow || input === 'j') setSelected((n) => (n + 1) % options.length);
    else if (key.return) onChoice(options[selected]?.choice ?? { kind: 'deny' });
    // Escape is a denial, not a dismissal: a prompt that can be closed without
    // answering would leave the turn waiting on a promise nothing will resolve.
    else if (key.escape) onChoice({ kind: 'deny', message: 'the user dismissed the prompt' });
  });

  const isDiff = request.detail.includes('\n@@') || request.detail.startsWith('---');

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={theme.warning} paddingX={1}>
      <Text bold color={theme.warning}>
        {request.title}
      </Text>
      <Text color={theme.muted}>{reason}</Text>
      <Box marginY={1} flexDirection="column">
        {isDiff ? <DiffView diff={request.detail} /> : <Text wrap="wrap">{request.detail}</Text>}
      </Box>
      {options.map((option, index) => (
        <Text key={option.label} color={index === selected ? theme.accent : option.color}>
          {index === selected ? '❯ ' : '  '}
          {option.label}
        </Text>
      ))}
    </Box>
  );
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}
