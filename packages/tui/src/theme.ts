/**
 * Colours are named by role rather than by hue so a future theme can be swapped
 * in one place. Only the sixteen ANSI names are used: a 24-bit palette looks
 * better on the terminals that support it and unreadable on the ones that map it
 * badly, and a coding agent has to be legible on a stranger's machine.
 */
export const theme = {
  user: 'cyan',
  assistant: 'white',
  reasoning: 'gray',
  tool: 'blue',
  toolError: 'red',
  added: 'green',
  removed: 'red',
  hunk: 'cyan',
  muted: 'gray',
  warning: 'yellow',
  danger: 'red',
  accent: 'magenta',
} as const;

/** Mode indicators for the status line, shortest first - the line is one row. */
export const MODE_LABEL: Record<string, string> = {
  plan: 'plan',
  ask: 'ask',
  'accept-edits': 'edits',
  auto: 'auto',
  yolo: 'yolo',
};

export const MODE_COLOR: Record<string, string> = {
  plan: theme.accent,
  ask: theme.muted,
  'accept-edits': theme.added,
  auto: theme.warning,
  yolo: theme.danger,
};
