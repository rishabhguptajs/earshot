import { type Curiosity, isCuriosity } from '@earshot/core';

/**
 * `--curiosity` and `--max-cost`, shared by the interactive and headless paths
 * so the two cannot drift on what a flag means. Both refuse a bad value rather
 * than falling back to a default: a script that asked for a $2 ceiling and
 * silently got none is the failure the flag exists to prevent.
 */
export function parseCuriosity(value: unknown): Curiosity | undefined | 'invalid' {
  if (value === undefined) return undefined;
  return isCuriosity(value) ? value : 'invalid';
}

export function parseMaxCost(value: unknown): number | undefined | 'invalid' {
  if (value === undefined) return undefined;
  const usd = typeof value === 'string' ? Number(value.replace(/^\$/, '')) : Number.NaN;
  if (!Number.isFinite(usd) || usd < 0) return 'invalid';
  return usd;
}
