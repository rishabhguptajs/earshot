/**
 * Frontmatter, hand-parsed, for the same reason the memory store parses its own:
 * these files are hand-written, and a real YAML parser's failure mode - throwing
 * on a file someone indented slightly wrong - is worse than ignoring a key we do
 * not recognise.
 */
export interface Frontmatter {
  fields: Map<string, string>;
  body: string;
}

export function parseFrontmatter(raw: string): Frontmatter {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(raw);
  if (!match) return { fields: new Map(), body: raw.trim() };

  const [, front = '', body = ''] = match;
  const fields = new Map<string, string>();
  for (const line of front.split(/\r?\n/)) {
    // Continuation lines of a block scalar are not supported and are skipped
    // rather than misread as keys.
    if (/^\s/.test(line)) continue;
    const at = line.indexOf(':');
    if (at <= 0) continue;
    fields.set(line.slice(0, at).trim().toLowerCase(), unquote(line.slice(at + 1).trim()));
  }
  return { fields, body: body.trim() };
}

/** `a, b` and `[a, b]` both read as a list; anything else reads as one item. */
export function parseList(value: string | undefined): string[] {
  if (value === undefined) return [];
  const inner = value.trim().replace(/^\[/, '').replace(/\]$/, '');
  return inner
    .split(',')
    .map((item) => unquote(item.trim()))
    .filter((item) => item !== '');
}

function unquote(value: string): string {
  if (value.startsWith('"') && value.endsWith('"') && value.length > 1) {
    try {
      return JSON.parse(value) as string;
    } catch {
      return value.slice(1, -1);
    }
  }
  if (value.startsWith("'") && value.endsWith("'") && value.length > 1) return value.slice(1, -1);
  return value;
}
