import { relative, sep } from 'node:path';
import { matchesGlob } from '../tools/glob-match.ts';
import type { PermissionRequest } from '../tools/types.ts';

/**
 * What the agent said it was going to do, before it did any of it.
 *
 * The scope is declared by the model in its own words and its own file list.
 * That is the point: a contract the agent wrote is one it can be held to, and
 * the check below is a comparison against that statement rather than a guess at
 * what the user meant.
 */
export interface Scope {
  /** Paths or globs, relative to the working directory. */
  files: string[];
  /** One paragraph: which behaviours change, and which do not. */
  intent: string;
  /** The agent's own estimate of the size of the change, in changed lines. */
  estimatedLines?: number;
}

export type ScopeConcern =
  | { kind: 'undeclared'; summary: string }
  | { kind: 'out-of-scope-file'; summary: string; path: string }
  | { kind: 'new-dependency'; summary: string }
  | { kind: 'rename-or-delete'; summary: string }
  | { kind: 'formatting-sweep'; summary: string }
  | { kind: 'test-removal'; summary: string }
  | { kind: 'over-budget'; summary: string; changed: number; budget: number };

export interface ScopeOptions {
  /**
   * Smallest turn that can be over budget. Below it the guard stays quiet: a
   * fifty-line change is not a scope violation whatever the estimate said, and
   * a guard that fires on those trains people to confirm without reading.
   */
  floorLines: number;
  /** How far past the agent's own estimate a turn may go before it confirms. */
  overrunFactor: number;
  /** Fires on the first mutating call when nothing has been declared. */
  requireDeclaration: boolean;
}

export const DEFAULT_SCOPE_OPTIONS: ScopeOptions = {
  floorLines: 150,
  overrunFactor: 3,
  requireDeclaration: false,
};

const DEPENDENCY_FILES = [
  'package.json',
  'bun.lock',
  'bun.lockb',
  'package-lock.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  'Cargo.toml',
  'Cargo.lock',
  'go.mod',
  'go.sum',
  'requirements.txt',
  'pyproject.toml',
  'Gemfile',
];

/** `npm i x`, `bun add x`, `cargo add x`, `pip install x`, and the rest. */
const INSTALL_COMMAND =
  /\b(?:npm|bun|pnpm|yarn)\s+(?:add|install|i)\b|\bcargo\s+add\b|\b(?:pip|pip3|uv)\s+(?:add|install)\b|\bgo\s+get\b/;

const MOVE_COMMAND = /\b(?:rm|mv|git\s+rm|git\s+mv)\b/;

const TEST_PATH = /(^|[/\\])(?:tests?|__tests__|spec)[/\\]|\.(?:test|spec)\.[cm]?[jt]sx?$/;

const TEST_DECLARATION = /\b(?:test|it|describe)\s*[.(]|\bdef\s+test_|\bfunc\s+Test[A-Z]/;

/**
 * Tracks the declared scope for a turn and reports what falls outside it.
 *
 * Deliberately not a line count. A line count either fires on every large change
 * the user actually asked for or never fires on the small wrong ones, so the
 * check is categorical - a file nobody mentioned, a dependency nobody asked for,
 * a rename, a formatting sweep, a deleted test - and the size limit is only a
 * backstop for the case where none of those name the problem.
 */
export class ScopeContract {
  private scope: Scope | undefined;
  private changedLines = 0;
  /** Concerns already confirmed, so the same one is not raised twice a turn. */
  private readonly accepted = new Set<string>();
  private readonly options: ScopeOptions;

  constructor(
    private readonly cwd: string,
    options: Partial<ScopeOptions> = {},
  ) {
    this.options = { ...DEFAULT_SCOPE_OPTIONS, ...options };
  }

  get declared(): Scope | undefined {
    return this.scope;
  }

  declare(scope: Scope): void {
    this.scope = scope;
    this.changedLines = 0;
    this.accepted.clear();
  }

  /** Widens the scope after the user confirmed something outside it. */
  widen(concern: ScopeConcern, path?: string): void {
    this.accepted.add(concern.kind);
    if (path && this.scope) this.scope = { ...this.scope, files: [...this.scope.files, path] };
  }

  /** Starts a new turn: the budget is per turn, the declaration is not. */
  beginTurn(): void {
    this.changedLines = 0;
    this.accepted.clear();
  }

  /**
   * Called after a change was approved and applied, so the running total counts
   * what happened rather than what was proposed.
   */
  record(request: PermissionRequest): void {
    this.changedLines += countChangedLines(request.detail);
  }

  /** The first thing about this call that falls outside what was declared. */
  check(request: PermissionRequest): ScopeConcern | undefined {
    const concern = this.classify(request);
    if (!concern || this.accepted.has(concern.kind)) return undefined;
    return concern;
  }

  private classify(request: PermissionRequest): ScopeConcern | undefined {
    const scope = this.scope;
    if (!scope) {
      if (!this.options.requireDeclaration) return undefined;
      return {
        kind: 'undeclared',
        summary:
          'This is the first change of the turn and no scope was declared. Say which files ' +
          'will change and what will change about them first.',
      };
    }

    const paths = (request.writes ?? []).map((path) => this.display(path));

    for (const path of paths) {
      // Named explicitly, not merely matched: a broad glob like `**` should not
      // silently license adding a dependency, which is the change most likely to
      // outlive the task that introduced it.
      if (isDependencyFile(path) && !scope.files.includes(path)) {
        return {
          kind: 'new-dependency',
          summary: `${path} declares this project's dependencies and is not in the declared scope.`,
        };
      }
      if (!this.covers(scope, path)) {
        return {
          kind: 'out-of-scope-file',
          path,
          summary: `${path} is not one of the files this turn said it would change (${scope.files.join(', ')}).`,
        };
      }
    }

    if (request.tool === 'Bash') {
      if (INSTALL_COMMAND.test(request.target)) {
        return {
          kind: 'new-dependency',
          summary: 'This command adds a dependency, which the task did not ask for.',
        };
      }
      if (MOVE_COMMAND.test(request.target)) {
        return {
          kind: 'rename-or-delete',
          summary: 'This command renames or deletes files, which the task did not ask for.',
        };
      }
    }

    const diff = summariseDiff(request.detail);
    if (diff.changed >= 20 && diff.whitespaceOnly) {
      return {
        kind: 'formatting-sweep',
        summary: `This change rewrites ${diff.changed} lines without changing what any of them say.`,
      };
    }
    if (diff.removedTests > 0 && paths.some((path) => TEST_PATH.test(path))) {
      return {
        kind: 'test-removal',
        summary: `This removes ${diff.removedTests} test${diff.removedTests === 1 ? '' : 's'}. A test that is in the way is usually reporting something real.`,
      };
    }

    const budget = Math.max(
      this.options.floorLines,
      (scope.estimatedLines ?? 0) * this.options.overrunFactor,
    );
    const total = this.changedLines + diff.changed;
    if (total > budget) {
      return {
        kind: 'over-budget',
        changed: total,
        budget,
        summary:
          `This turn has changed ${total} lines against an estimate of ` +
          `${scope.estimatedLines ?? 'none'}. A change several times the size of the one ` +
          'described is usually a different change.',
      };
    }
    return undefined;
  }

  private covers(scope: Scope, path: string): boolean {
    return scope.files.some(
      (pattern) => pattern === path || matchesGlob(pattern, path) || path.startsWith(`${pattern}/`),
    );
  }

  private display(path: string): string {
    const rel = relative(this.cwd, path);
    return rel === '' || rel.startsWith('..') ? path : rel.split(sep).join('/');
  }
}

function isDependencyFile(path: string): boolean {
  const name = path.split('/').pop() ?? path;
  return DEPENDENCY_FILES.includes(name);
}

export function countChangedLines(diff: string): number {
  return summariseDiff(diff).changed;
}

interface DiffSummary {
  changed: number;
  /** True when the added and removed lines differ only in whitespace. */
  whitespaceOnly: boolean;
  removedTests: number;
}

/**
 * Reads the unified diff the permission prompt already shows.
 *
 * Nothing here re-derives the change from the tool input: the diff is what the
 * user was shown and approved, so it is also what the guard should measure.
 */
export function summariseDiff(detail: string): DiffSummary {
  const added: string[] = [];
  const removed: string[] = [];
  for (const line of detail.split('\n')) {
    if (line.startsWith('+++') || line.startsWith('---') || line.startsWith('@@')) continue;
    if (line.startsWith('+')) added.push(line.slice(1));
    else if (line.startsWith('-')) removed.push(line.slice(1));
  }

  const squash = (lines: string[]) => lines.join('').replace(/\s+/g, '');
  const removedTests = removed.filter((line) => TEST_DECLARATION.test(line)).length;
  const addedTests = added.filter((line) => TEST_DECLARATION.test(line)).length;

  return {
    changed: added.length + removed.length,
    whitespaceOnly: added.length > 0 && removed.length > 0 && squash(added) === squash(removed),
    removedTests: Math.max(0, removedTests - addedTests),
  };
}
