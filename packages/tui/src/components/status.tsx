import type { PermissionMode, TodoItem } from '@earshot/core';
import { Box, Text } from 'ink';
import { MODE_COLOR, MODE_LABEL, theme } from '../theme.ts';

export interface StatusLineProps {
  model: string;
  mode: PermissionMode;
  costUsd: number;
  todos: TodoItem[];
  busy: boolean;
  queued: number;
}

/**
 * One row, always present. Everything on it answers a question the user would
 * otherwise have to interrupt to ask: which model is spending their money, how
 * much it has spent, what the agent thinks it is doing, and whether the thing
 * they just typed was received.
 */
export function StatusLine({ model, mode, costUsd, todos, busy, queued }: StatusLineProps) {
  const done = todos.filter((todo) => todo.status === 'done').length;
  const current = todos.find((todo) => todo.status === 'in_progress');

  return (
    <Box>
      <Text color={MODE_COLOR[mode] ?? theme.muted}>{MODE_LABEL[mode] ?? mode}</Text>
      <Text color={theme.muted}> · {model}</Text>
      <Text color={theme.muted}> · ${costUsd.toFixed(4)}</Text>
      {todos.length > 0 && (
        <Text color={theme.muted}>
          {' '}
          · {done}/{todos.length}
          {current ? ` ${truncate(current.text, 40)}` : ''}
        </Text>
      )}
      {busy && <Text color={theme.warning}> · working (esc to interrupt)</Text>}
      {queued > 0 && <Text color={theme.accent}> · {queued} queued</Text>}
    </Box>
  );
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}
