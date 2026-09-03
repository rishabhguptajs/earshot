import { Text, useInput } from 'ink';
import { useEffect, useRef } from 'react';
import { theme } from '../theme.ts';

export interface TextInputProps {
  value: string;
  onChange: (value: string) => void;
  onSubmit?: (value: string) => void;
  placeholder?: string;
  isActive?: boolean;
}

/**
 * A single-line controlled input.
 *
 * Hand-written rather than pulled from `ink-text-input`, which has not kept pace
 * with Ink's major versions and would add a dependency for about thirty lines.
 * The cursor is rendered as an inverted character rather than moved with an
 * escape sequence, so nothing here writes cursor-control codes that ConPTY
 * handles differently from a POSIX terminal.
 */
export function TextInput({
  value,
  onChange,
  onSubmit,
  placeholder = '',
  isActive = true,
}: TextInputProps) {
  /**
   * The edit buffer is tracked in a ref as well as in the parent's state.
   *
   * Several keystrokes can arrive in one tick - fast typing, and every paste -
   * and each handler would then read the same pre-render `value` prop, so all
   * but the last character would be silently dropped and a Return arriving in
   * the same tick would submit a stale string. The ref carries the edit forward
   * within a tick; the effect resyncs it whenever the parent changes the value
   * itself, such as clearing the line after a submit.
   */
  const buffer = useRef(value);
  useEffect(() => {
    buffer.current = value;
  }, [value]);

  useInput(
    (input, key) => {
      if (key.return) {
        const submitted = buffer.current;
        buffer.current = '';
        onSubmit?.(submitted);
        return;
      }
      if (key.backspace || key.delete) {
        buffer.current = buffer.current.slice(0, -1);
        onChange(buffer.current);
        return;
      }
      // Control sequences arrive as `input` too; only printable text is appended.
      if (key.ctrl || key.meta || key.escape || key.tab) return;
      if (key.upArrow || key.downArrow || key.leftArrow || key.rightArrow) return;
      if (input) {
        buffer.current += input;
        onChange(buffer.current);
      }
    },
    { isActive },
  );

  if (value === '') {
    return (
      <Text>
        <Text inverse> </Text>
        <Text color={theme.muted}>{placeholder}</Text>
      </Text>
    );
  }

  return (
    <Text>
      {value}
      <Text inverse> </Text>
    </Text>
  );
}
