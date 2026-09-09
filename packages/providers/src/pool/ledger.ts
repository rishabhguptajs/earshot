import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { ledgerFile } from '../paths.ts';

/**
 * Quota counters for free tiers, one bucket per *account*.
 *
 * The point of the ledger is to decide not to make a request. A pool that
 * discovers exhaustion by getting a 429 wastes a round trip on every provider
 * it has already spent, and on a slow tier that is seconds of dead time per
 * turn. Counting locally is approximate - it cannot see requests made by other
 * tools using the same key - so it is a floor, not a truth, and an actual 429
 * always wins over what was counted.
 *
 * Nothing here is precious. If the file is lost, corrupt or written by a newer
 * earshot, it is discarded and rebuilt: the worst case is one wasted request.
 */

export interface QuotaLimits {
  /** Requests per minute. */
  rpm?: number;
  /** Requests per day. */
  rpd?: number;
  /** Tokens per minute. */
  tpm?: number;
  /** Tokens per day. */
  tpd?: number;
}

interface Counter {
  /** The window this counter belongs to, as a floor index. */
  window: number;
  requests: number;
  tokens: number;
}

export interface Bucket {
  minute: Counter;
  day: Counter;
  /**
   * Limits narrowed by what actually happened. A vendor's published numbers go
   * stale and differ per model; a 429 at 12 requests is proof the real ceiling
   * is at most 12, whatever the table says.
   */
  learned?: { rpm?: number; rpd?: number };
  /** Set from `Retry-After`. Until this passes, the account is not offered. */
  cooldownUntil?: number;
}

type LedgerShape = { version: 1; buckets: Record<string, Bucket> };

const MINUTE = 60_000;
const DAY = 86_400_000;

/** Buckets are per account, because that is what vendors meter. */
export const bucketKey = (providerId: string, account: string): string =>
  `${providerId}#${account}`;

const emptyCounter = (window: number): Counter => ({ window, requests: 0, tokens: 0 });

/**
 * Daily windows roll at UTC midnight.
 *
 * Vendors reset on their own schedules and almost none of them say when, so
 * there is no correct answer available. UTC is at least the same everywhere and
 * does not shift under the user twice a year; a `Retry-After` on the eventual
 * 429 corrects the real boundary far better than a guess at a timezone would.
 */
function rolled(counter: Counter | undefined, window: number): Counter {
  return counter && counter.window === window ? counter : emptyCounter(window);
}

function freshBucket(bucket: Bucket | undefined, now: number): Bucket {
  const minute = Math.floor(now / MINUTE);
  const day = Math.floor(now / DAY);
  return {
    minute: rolled(bucket?.minute, minute),
    day: rolled(bucket?.day, day),
    ...(bucket?.learned ? { learned: bucket.learned } : {}),
    ...(bucket?.cooldownUntil ? { cooldownUntil: bucket.cooldownUntil } : {}),
  };
}

/** Why an account cannot be used right now, and when that stops being true. */
export type Headroom = { ok: true } | { ok: false; reason: string; retryAt: number };

export function headroomOf(bucket: Bucket | undefined, limits: QuotaLimits, now: number): Headroom {
  const current = freshBucket(bucket, now);
  if (current.cooldownUntil && current.cooldownUntil > now) {
    return { ok: false, reason: 'rate limited', retryAt: current.cooldownUntil };
  }

  const endOfMinute = (current.minute.window + 1) * MINUTE;
  const endOfDay = (current.day.window + 1) * DAY;
  const rpm = Math.min(limits.rpm ?? Infinity, current.learned?.rpm ?? Infinity);
  const rpd = Math.min(limits.rpd ?? Infinity, current.learned?.rpd ?? Infinity);

  if (current.minute.requests >= rpm)
    return { ok: false, reason: 'requests per minute', retryAt: endOfMinute };
  if (current.day.requests >= rpd)
    return { ok: false, reason: 'requests per day', retryAt: endOfDay };
  if (limits.tpm !== undefined && current.minute.tokens >= limits.tpm)
    return { ok: false, reason: 'tokens per minute', retryAt: endOfMinute };
  if (limits.tpd !== undefined && current.day.tokens >= limits.tpd)
    return { ok: false, reason: 'tokens per day', retryAt: endOfDay };
  return { ok: true };
}

/**
 * The on-disk ledger.
 *
 * Every mutation re-reads the file under a lock rather than trusting an
 * in-memory copy: several earshot processes share one ledger, and a cached
 * write would silently discard whatever the others counted.
 */
export class QuotaLedger {
  #path: string;
  #lockTimeoutMs: number;

  constructor(path = ledgerFile(), lockTimeoutMs = 2_000) {
    this.#path = path;
    this.#lockTimeoutMs = lockTimeoutMs;
  }

  async read(): Promise<Record<string, Bucket>> {
    try {
      const parsed = JSON.parse(await readFile(this.#path, 'utf8')) as LedgerShape;
      return parsed.version === 1 && parsed.buckets ? parsed.buckets : {};
    } catch {
      return {};
    }
  }

  async headroom(key: string, limits: QuotaLimits, now = Date.now()): Promise<Headroom> {
    return headroomOf((await this.read())[key], limits, now);
  }

  /** Counts a request before it is made, so a crash overcounts rather than under. */
  async reserve(key: string, now = Date.now()): Promise<void> {
    await this.#mutate(key, now, (bucket) => {
      bucket.minute.requests += 1;
      bucket.day.requests += 1;
    });
  }

  async recordTokens(key: string, tokens: number, now = Date.now()): Promise<void> {
    if (tokens <= 0) return;
    await this.#mutate(key, now, (bucket) => {
      bucket.minute.tokens += tokens;
      bucket.day.tokens += tokens;
    });
  }

  /**
   * A 429 is the only authoritative statement about a limit anyone gets, so it
   * both parks the account and narrows what we believe the ceiling to be.
   */
  async recordRateLimit(
    key: string,
    retryAfterMs: number | undefined,
    now = Date.now(),
  ): Promise<void> {
    await this.#mutate(key, now, (bucket) => {
      bucket.cooldownUntil = now + (retryAfterMs ?? MINUTE);
      const learned = { ...bucket.learned };
      // Counted requests include this one, and it was refused - so the ceiling
      // is below what we have counted, never at it.
      const seen = Math.max(1, bucket.minute.requests - 1);
      if (retryAfterMs === undefined || retryAfterMs <= MINUTE) {
        learned.rpm = Math.min(learned.rpm ?? Infinity, seen);
      } else {
        learned.rpd = Math.min(learned.rpd ?? Infinity, Math.max(1, bucket.day.requests - 1));
      }
      bucket.learned = learned;
    });
  }

  /** Forgets a cooldown, for `pool status --reset` and for tests. */
  async clear(key?: string): Promise<void> {
    await this.#withLock(async () => {
      const buckets = key ? await this.read() : {};
      if (key) delete buckets[key];
      await this.#write(buckets);
    });
  }

  async #mutate(key: string, now: number, apply: (bucket: Bucket) => void): Promise<void> {
    await this.#withLock(async () => {
      const buckets = await this.read();
      const bucket = freshBucket(buckets[key], now);
      apply(bucket);
      buckets[key] = bucket;
      await this.#write(buckets);
    });
  }

  async #write(buckets: Record<string, Bucket>): Promise<void> {
    const data: LedgerShape = { version: 1, buckets };
    await mkdir(dirname(this.#path), { recursive: true });
    const tmp = `${this.#path}.${process.pid}.tmp`;
    await writeFile(tmp, `${JSON.stringify(data)}\n`, 'utf8');
    await rename(tmp, this.#path);
  }

  /**
   * `mkdir` is the lock: it is atomic on every filesystem we run on, and unlike
   * an advisory lock it leaves something visible behind if a process dies. A
   * A lock that remains contended is bypassed rather than waited on forever -
   * quota counting is not worth deadlocking a session over. A process that
   * bypasses the lock must not remove it, because another writer owns it.
   */
  async #withLock<T>(fn: () => Promise<T>): Promise<T> {
    const lock = `${this.#path}.lock`;
    const deadline = Date.now() + this.#lockTimeoutMs;
    let acquired = false;
    for (;;) {
      try {
        await mkdir(dirname(lock), { recursive: true });
        await mkdir(lock);
        acquired = true;
        break;
      } catch {
        if (Date.now() > deadline) break; // stale or contended; proceed anyway
        await new Promise((resolve) => setTimeout(resolve, 15));
      }
    }
    try {
      return await fn();
    } finally {
      if (acquired) await rm(lock, { recursive: true, force: true }).catch(() => {});
    }
  }
}
