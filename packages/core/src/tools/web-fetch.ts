import { num, object, opt, optionalNumber, requireString, str } from './schema.ts';
import { defineTool, type Tool, ToolInputError, text } from './types.ts';

const DEFAULT_MAX_CHARS = 40_000;
const TIMEOUT_MS = 30_000;

interface WebFetchInput {
  url: string;
  maxChars?: number;
}

export const webFetchTool: Tool<WebFetchInput> = defineTool<WebFetchInput>({
  name: 'web_fetch',
  description:
    'Fetch a URL and return its text content, with HTML reduced to readable text. ' +
    'Use it to read documentation, changelogs and issues the user points at.',
  // Not read-only: it reaches the network, so it can leak what the agent is
  // working on to a third party and can be pointed at an internal address. The
  // gate sees the URL.
  readOnly: false,
  inputSchema: object(
    {
      url: str('Absolute http(s) URL to fetch.'),
      maxChars: num(`Maximum characters to return. Defaults to ${DEFAULT_MAX_CHARS}.`),
    },
    ['url'],
  ),
  parse: (input) => {
    const url = requireString(input, 'url');
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new ToolInputError(`"${url}" is not a valid URL`);
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new ToolInputError('only http and https URLs can be fetched');
    }
    return { url, ...opt('maxChars', optionalNumber(input, 'maxChars')) };
  },
  permission: (input) => ({
    tool: 'WebFetch',
    target: new URL(input.url).host,
    title: `fetch ${input.url}`,
    detail: input.url,
  }),
  async execute(input, ctx) {
    const response = await fetch(input.url, {
      redirect: 'follow',
      signal: AbortSignal.any([ctx.signal, AbortSignal.timeout(TIMEOUT_MS)]),
      headers: { accept: 'text/html,text/plain,application/json;q=0.9,*/*;q=0.8' },
    }).catch((error: Error) => {
      throw new ToolInputError(`fetch failed: ${error.message}`);
    });

    if (!response.ok) {
      return {
        output: text(`${response.status} ${response.statusText} from ${input.url}`),
        isError: true,
        title: `${input.url} (${response.status})`,
      };
    }

    const contentType = response.headers.get('content-type') ?? '';
    const body = await response.text();
    const content = contentType.includes('html') ? htmlToText(body) : body;

    const max = input.maxChars ?? DEFAULT_MAX_CHARS;
    const clipped = content.length > max ? `${content.slice(0, max)}\n\n[truncated]` : content;
    return { output: text(clipped), title: input.url };
  },
});

/**
 * A deliberately crude HTML-to-text pass: drop the parts that are never content,
 * unwrap the rest, and decode the handful of entities that actually show up. A
 * real parser would be a dependency and a maintenance surface for output the
 * model reads approximately anyway.
 */
export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style|noscript|svg|head)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<\/(p|div|li|tr|h[1-6]|section|article)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<li\b[^>]*>/gi, '- ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .split('\n')
    .map((line) => line.trim())
    .join('\n')
    .trim();
}
