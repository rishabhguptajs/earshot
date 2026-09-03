/**
 * A unified diff, generated in-process. The permission prompt must show the real
 * change - a summary is exactly the thing that lets a bad edit through - so this
 * is on the path of every `write`, `edit` and `multi_edit` approval.
 */
export function unifiedDiff(path: string, before: string, after: string, context = 3): string {
  const a = before === '' ? [] : before.split('\n');
  const b = after === '' ? [] : after.split('\n');
  const ops = diffLines(a, b);
  if (ops.every((op) => op.kind === 'same')) return '';

  const lines: string[] = [`--- a/${path}`, `+++ b/${path}`];
  for (const hunk of hunks(ops, context)) {
    lines.push(
      `@@ -${hunk.aStart + 1},${hunk.aCount} +${hunk.bStart + 1},${hunk.bCount} @@`,
      ...hunk.lines,
    );
  }
  return lines.join('\n');
}

type Op = { kind: 'same' | 'del' | 'add'; text: string };

/**
 * Plain LCS. Tool edits are small and local; the quadratic table is cheaper in
 * both code and wall time than a Myers implementation at these sizes, and a
 * whole-file rewrite degrades to "delete everything, add everything", which is
 * the correct diff anyway.
 */
function diffLines(a: string[], b: string[]): Op[] {
  const n = a.length;
  const m = b.length;
  const table: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    const row = table[i] as number[];
    const next = table[i + 1] as number[];
    for (let j = m - 1; j >= 0; j--) {
      row[j] =
        a[i] === b[j]
          ? (next[j + 1] as number) + 1
          : Math.max(next[j] as number, row[j + 1] as number);
    }
  }

  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ kind: 'same', text: a[i] as string });
      i++;
      j++;
    } else if ((table[i + 1]?.[j] as number) >= (table[i]?.[j + 1] as number)) {
      ops.push({ kind: 'del', text: a[i] as string });
      i++;
    } else {
      ops.push({ kind: 'add', text: b[j] as string });
      j++;
    }
  }
  while (i < n) ops.push({ kind: 'del', text: a[i++] as string });
  while (j < m) ops.push({ kind: 'add', text: b[j++] as string });
  return ops;
}

interface Hunk {
  aStart: number;
  bStart: number;
  aCount: number;
  bCount: number;
  lines: string[];
}

function hunks(ops: Op[], context: number): Hunk[] {
  const changed = ops.map((op) => op.kind !== 'same');
  const keep = ops.map((_, i) =>
    changed.slice(Math.max(0, i - context), i + context + 1).some(Boolean),
  );

  const out: Hunk[] = [];
  let aLine = 0;
  let bLine = 0;
  let current: Hunk | undefined;

  for (const [i, op] of ops.entries()) {
    if (keep[i]) {
      current ??= { aStart: aLine, bStart: bLine, aCount: 0, bCount: 0, lines: [] };
      if (op.kind === 'same') {
        current.lines.push(` ${op.text}`);
        current.aCount++;
        current.bCount++;
      } else if (op.kind === 'del') {
        current.lines.push(`-${op.text}`);
        current.aCount++;
      } else {
        current.lines.push(`+${op.text}`);
        current.bCount++;
      }
    } else if (current) {
      out.push(current);
      current = undefined;
    }
    if (op.kind !== 'add') aLine++;
    if (op.kind !== 'del') bLine++;
  }
  if (current) out.push(current);
  return out;
}
