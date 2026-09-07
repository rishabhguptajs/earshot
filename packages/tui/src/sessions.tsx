import type { SessionInfo } from '@earshot/core';
import { Box, Text, useApp, useInput } from 'ink';
import { useMemo, useState } from 'react';
import { TextInput } from './components/text-input.tsx';
import { theme } from './theme.ts';

export function SessionPicker({
  sessions,
  onDone,
  embedded = false,
}: {
  sessions: readonly SessionInfo[];
  onDone(path?: string): void;
  embedded?: boolean;
}) {
  const { exit } = useApp();
  const [query, setQuery] = useState('');
  const [cursor, setCursor] = useState(0);
  const matches = useMemo(() => {
    const wanted = query.trim().toLowerCase();
    return wanted
      ? sessions.filter((session) =>
          `${session.preview} ${session.model} ${session.id}`.toLowerCase().includes(wanted),
        )
      : sessions;
  }, [query, sessions]);

  const finish = (path?: string) => {
    onDone(path);
    if (!embedded) exit();
  };

  useInput((input, key) => {
    if (key.escape || (input === 'q' && query === '')) return finish();
    if (key.upArrow)
      setCursor((value) => (value <= 0 ? Math.max(0, matches.length - 1) : value - 1));
    if (key.downArrow) setCursor((value) => (value >= matches.length - 1 ? 0 : value + 1));
  });

  return (
    <Box flexDirection="column">
      <Text>saved chats for this project</Text>
      <Box marginTop={1}>
        <Text color={theme.user}>{'> '}</Text>
        <TextInput
          value={query}
          onChange={(value) => {
            setQuery(value);
            setCursor(0);
          }}
          onSubmit={() => {
            const selected = matches[cursor];
            if (selected) finish(selected.path);
          }}
          placeholder="filter chats"
        />
      </Box>
      <Box flexDirection="column" marginTop={1}>
        {matches.slice(Math.max(0, cursor - 4), Math.max(0, cursor - 4) + 9).map((session) => (
          <Text key={session.id} color={session === matches[cursor] ? theme.user : theme.muted}>
            {session === matches[cursor] ? '› ' : '  '}
            {session.preview.padEnd(42).slice(0, 42)} {relativeTime(session.updatedAt).padStart(8)}{' '}
            {session.model} {session.id.slice(0, 8)}
          </Text>
        ))}
        {matches.length === 0 && <Text color={theme.muted}>no saved chats match</Text>}
      </Box>
      <Box marginTop={1}>
        <Text color={theme.muted}>type filter · ↑↓ choose · enter resume · esc quit</Text>
      </Box>
    </Box>
  );
}

function relativeTime(updatedAt: number): string {
  const seconds = Math.max(0, Math.floor((Date.now() - updatedAt) / 1000));
  if (seconds < 60) return 'now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}
