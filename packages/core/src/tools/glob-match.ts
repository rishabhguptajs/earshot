/**
 * Glob matching over `/`-separated paths. Hand-rolled because the one thing a
 * dependency would add here is `**` semantics, and getting those wrong is the
 * whole bug surface - so they are tested directly instead.
 *
 * Supports `*` (no separator), `**` (any depth, including none), `?`, and
 * `{a,b}` alternation. A leading `**\/` is implied for a pattern with no
 * separator, so `*.ts` matches `src/main.ts` the way every other tool behaves.
 */
export function globToRegExp(pattern: string): RegExp {
  const implicitlyRecursive = !pattern.includes('/');
  const source = implicitlyRecursive ? `**/${pattern}` : pattern;
  return new RegExp(`^${compile(source)}$`);
}

export function matchesGlob(pattern: string, path: string): boolean {
  return globToRegExp(pattern).test(path);
}

function compile(pattern: string): string {
  let out = '';
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i] as string;
    if (ch === '*') {
      if (pattern[i + 1] === '*') {
        // `**/` collapses to "any number of segments, including zero", which is
        // what makes `src/**/*.ts` match `src/main.ts` and not just nested files.
        i++;
        if (pattern[i + 1] === '/') {
          i++;
          out += '(?:[^/]+/)*';
        } else {
          out += '.*';
        }
      } else {
        out += '[^/]*';
      }
    } else if (ch === '?') {
      out += '[^/]';
    } else if (ch === '{') {
      const end = pattern.indexOf('}', i);
      if (end === -1) {
        out += '\\{';
      } else {
        const alts = pattern.slice(i + 1, end).split(',');
        out += `(?:${alts.map(compile).join('|')})`;
        i = end;
      }
    } else {
      out += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  return out;
}
