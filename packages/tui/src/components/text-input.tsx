import { Text, useInput } from 'ink';
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
  useInput(
    (input, key) => {
      if (key.return) {
        onSubmit?.(value);
        return;
      }
      if (key.backspace || key.delete) {
        onChange(value.slice(0, -1));
        return;
      }
      // Control sequences arrive as `input` too; only printable text is appended.
      if (key.ctrl || key.meta || key.escape || key.tab) return;
      if (key.upArrow || key.downArrow || key.leftArrow || key.rightArrow) return;
      if (input) onChange(value + input);
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
