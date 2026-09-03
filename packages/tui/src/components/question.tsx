import { Box, Text, useInput } from 'ink';
import { useState } from 'react';
import { theme } from '../theme.ts';
import { TextInput } from './text-input.tsx';

export interface QuestionPromptProps {
  question: string;
  options?: string[];
  onAnswer: (answer: string) => void;
}

/**
 * What `ask_user` renders. Offered options are selectable, but a free-text answer
 * is always available: the model's suggestions are guesses, and forcing the user
 * into one of them is exactly the not-listening this project exists to avoid.
 */
export function QuestionPrompt({ question, options = [], onAnswer }: QuestionPromptProps) {
  const [selected, setSelected] = useState(0);
  const [typing, setTyping] = useState(options.length === 0);
  const [value, setValue] = useState('');

  useInput(
    (input, key) => {
      if (key.upArrow) setSelected((n) => (n + options.length - 1) % options.length);
      else if (key.downArrow) setSelected((n) => (n + 1) % options.length);
      else if (key.return) onAnswer(options[selected] ?? '');
      else if (input && !key.ctrl && !key.meta) {
        // Typing a printable character switches to free text and keeps it, so the
        // first keystroke of an answer is never swallowed by the option list.
        setTyping(true);
        setValue(input);
      }
    },
    { isActive: !typing },
  );

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={theme.accent} paddingX={1}>
      <Text bold color={theme.accent}>
        {question}
      </Text>
      {!typing &&
        options.map((option, index) => (
          <Text key={option} color={index === selected ? theme.accent : theme.muted}>
            {index === selected ? '❯ ' : '  '}
            {option}
          </Text>
        ))}
      {!typing && <Text color={theme.muted}>or start typing to answer in your own words</Text>}
      {typing && (
        <TextInput
          value={value}
          onChange={setValue}
          onSubmit={(answer) => onAnswer(answer.trim())}
          placeholder="your answer"
        />
      )}
    </Box>
  );
}
