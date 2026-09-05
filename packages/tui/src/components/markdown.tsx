import { Box, Text } from 'ink';
import { theme } from '../theme.ts';

/**
 * Renders a model's markdown as styled terminal text.
 *
 * Not a spec-complete parser - just the subset a model actually produces in
 * conversation: headers, bold/italic, inline and fenced code, lists, block
 * quotes and rules. Anything else falls through as plain text rather than
 * failing, since a raw line is still more readable than a crash.
 */
export function Markdown({ text }: { text: string }) {
  const blocks = splitBlocks(text);
  return (
    <Box flexDirection="column">
      {blocks.map((block, index) => (
        // Blocks have no identity beyond position: the whole text is replaced
        // wholesale on every render, never reordered in place.
        // biome-ignore lint/suspicious/noArrayIndexKey: position is the identity
        <Block key={index} block={block} />
      ))}
    </Box>
  );
}

type ParsedBlock =
  | { kind: 'code'; lang: string; lines: string[] }
  | { kind: 'heading'; level: number; text: string }
  | { kind: 'rule' }
  | { kind: 'list'; ordered: boolean; items: string[] }
  | { kind: 'quote'; lines: string[] }
  | { kind: 'paragraph'; text: string };

function splitBlocks(text: string): ParsedBlock[] {
  const lines = text.split('\n');
  const blocks: ParsedBlock[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index] ?? '';

    if (line.trim() === '') {
      index++;
      continue;
    }

    const fence = line.match(/^```(\w*)\s*$/);
    if (fence) {
      const lang = fence[1] ?? '';
      const codeLines: string[] = [];
      index++;
      while (index < lines.length && !/^```\s*$/.test(lines[index] ?? '')) {
        codeLines.push(lines[index] ?? '');
        index++;
      }
      index++; // closing fence
      blocks.push({ kind: 'code', lang, lines: codeLines });
      continue;
    }

    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      blocks.push({ kind: 'heading', level: heading[1]?.length ?? 1, text: heading[2] ?? '' });
      index++;
      continue;
    }

    if (/^(-{3,}|\*{3,}|_{3,})\s*$/.test(line.trim())) {
      blocks.push({ kind: 'rule' });
      index++;
      continue;
    }

    const listItem = line.match(/^\s*([-*]|\d+[.)])\s+(.*)$/);
    if (listItem) {
      const ordered = /\d/.test(listItem[1] ?? '');
      const items: string[] = [];
      while (index < lines.length) {
        const match = (lines[index] ?? '').match(/^\s*(?:[-*]|\d+[.)])\s+(.*)$/);
        if (!match) break;
        items.push(match[1] ?? '');
        index++;
      }
      blocks.push({ kind: 'list', ordered, items });
      continue;
    }

    if (line.trimStart().startsWith('>')) {
      const quoteLines: string[] = [];
      while (index < lines.length && (lines[index] ?? '').trimStart().startsWith('>')) {
        quoteLines.push((lines[index] ?? '').trimStart().replace(/^>\s?/, ''));
        index++;
      }
      blocks.push({ kind: 'quote', lines: quoteLines });
      continue;
    }

    const paragraphLines: string[] = [];
    while (index < lines.length && (lines[index] ?? '').trim() !== '') {
      const current = lines[index] ?? '';
      if (
        /^```/.test(current) ||
        /^(#{1,6})\s+/.test(current) ||
        /^\s*([-*]|\d+[.)])\s+/.test(current) ||
        current.trimStart().startsWith('>')
      ) {
        break;
      }
      paragraphLines.push(current);
      index++;
    }
    blocks.push({ kind: 'paragraph', text: paragraphLines.join(' ') });
  }

  return blocks;
}

function Block({ block }: { block: ParsedBlock }) {
  switch (block.kind) {
    case 'code':
      return (
        <Box flexDirection="column" marginY={1} paddingLeft={2}>
          {block.lines.map((line, index) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: position is the identity
            <Text key={index} color={theme.tool}>
              {line}
            </Text>
          ))}
        </Box>
      );
    case 'heading':
      return (
        <Box marginTop={block.level <= 2 ? 1 : 0}>
          <Text bold underline={block.level === 1} color={theme.assistant}>
            {inlineToText(block.text)}
          </Text>
        </Box>
      );
    case 'rule':
      return <Text color={theme.muted}>{'─'.repeat(40)}</Text>;
    case 'list':
      return (
        <Box flexDirection="column">
          {block.items.map((item, index) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: position is the identity
            <Text key={index}>
              {'  '}
              {block.ordered ? `${index + 1}.` : '-'} <Inline text={item} />
            </Text>
          ))}
        </Box>
      );
    case 'quote':
      return (
        <Box flexDirection="column" paddingLeft={1}>
          {block.lines.map((line, index) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: position is the identity
            <Text key={index} color={theme.muted} italic>
              │ {inlineToText(line)}
            </Text>
          ))}
        </Box>
      );
    default:
      return (
        <Text>
          <Inline text={block.text} />
        </Text>
      );
  }
}

/** Strips inline markers for contexts (headings, quotes) that render as one line. */
function inlineToText(text: string): string {
  return text
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/__(.+?)__/g, '$1')
    .replace(/\*(.+?)\*/g, '$1')
    .replace(/_(.+?)_/g, '$1')
    .replace(/`(.+?)`/g, '$1');
}

/**
 * Splits one line into bold/italic/code spans and renders each with its own
 * styling, in order - the only way Ink can mix styles within a single line.
 */
function Inline({ text }: { text: string }) {
  const pattern = /(\*\*.+?\*\*|__.+?__|`.+?`|\*.+?\*|_.+?_)/g;
  const parts = text.split(pattern);

  return (
    <>
      {parts.map((part, index) => {
        if (part === '') return null;
        if (part.startsWith('**') && part.endsWith('**')) {
          return (
            // biome-ignore lint/suspicious/noArrayIndexKey: position is the identity
            <Text key={index} bold>
              {part.slice(2, -2)}
            </Text>
          );
        }
        if (part.startsWith('__') && part.endsWith('__')) {
          return (
            // biome-ignore lint/suspicious/noArrayIndexKey: position is the identity
            <Text key={index} bold>
              {part.slice(2, -2)}
            </Text>
          );
        }
        if (part.startsWith('`') && part.endsWith('`')) {
          return (
            // biome-ignore lint/suspicious/noArrayIndexKey: position is the identity
            <Text key={index} color={theme.tool}>
              {part.slice(1, -1)}
            </Text>
          );
        }
        if (part.startsWith('*') && part.endsWith('*')) {
          return (
            // biome-ignore lint/suspicious/noArrayIndexKey: position is the identity
            <Text key={index} italic>
              {part.slice(1, -1)}
            </Text>
          );
        }
        if (part.startsWith('_') && part.endsWith('_')) {
          return (
            // biome-ignore lint/suspicious/noArrayIndexKey: position is the identity
            <Text key={index} italic>
              {part.slice(1, -1)}
            </Text>
          );
        }
        return (
          // biome-ignore lint/suspicious/noArrayIndexKey: position is the identity
          <Text key={index}>{part}</Text>
        );
      })}
    </>
  );
}
