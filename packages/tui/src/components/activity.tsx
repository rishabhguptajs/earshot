import { Text } from 'ink';
import { useEffect, useState } from 'react';
import { theme } from '../theme.ts';

const FRAMES = ['·  ', '·· ', '···', ' ··', '  ·', '   '] as const;

export function Activity({ label }: { label?: string }) {
  const [frame, setFrame] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setFrame((value) => (value + 1) % FRAMES.length), 120);
    return () => clearInterval(timer);
  }, []);
  return <Text color={theme.muted}>{label ? `${label} ${FRAMES[frame]}` : FRAMES[frame]}</Text>;
}
