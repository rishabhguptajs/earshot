import { describe, expect, test } from 'bun:test';
import { access, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bucketKey, headroomOf, QuotaLedger } from '../src/pool/ledger.ts';

async function tempLedger() {
  return new QuotaLedger(join(await mkdtemp(join(tmpdir(), 'earshot-pool-')), 'ledger.json'));
}

/** A fixed instant well inside a minute and a UTC day, so rolls are deliberate. */
const NOON = Date.UTC(2026, 0, 15, 12, 30, 30);
const MINUTE = 60_000;

describe('quota headroom', () => {
  test('an empty bucket has room', () => {
    expect(headroomOf(undefined, { rpm: 10 }, NOON)).toEqual({ ok: true });
  });

  test('reports which limit was hit and when it lifts', async () => {
    const ledger = await tempLedger();
    const key = bucketKey('groq', 'default');
    for (let i = 0; i < 3; i++) await ledger.reserve(key, NOON);

    const room = await ledger.headroom(key, { rpm: 3 }, NOON);
    expect(room.ok).toBe(false);
    if (room.ok) throw new Error('expected no headroom');
    expect(room.reason).toBe('requests per minute');
    // The next minute boundary, not "a minute from now".
    expect(room.retryAt).toBe((Math.floor(NOON / MINUTE) + 1) * MINUTE);
  });

  test('a per-minute counter rolls but the daily one does not', async () => {
    const ledger = await tempLedger();
    const key = bucketKey('groq', 'default');
    for (let i = 0; i < 3; i++) await ledger.reserve(key, NOON);

    expect(await ledger.headroom(key, { rpm: 3 }, NOON + MINUTE)).toEqual({ ok: true });
    const daily = await ledger.headroom(key, { rpd: 3 }, NOON + MINUTE);
    expect(daily.ok).toBe(false);
  });

  test('the daily window rolls at UTC midnight', async () => {
    const ledger = await tempLedger();
    const key = bucketKey('groq', 'default');
    await ledger.reserve(key, NOON);

    const beforeMidnight = Date.UTC(2026, 0, 15, 23, 59, 0);
    expect((await ledger.headroom(key, { rpd: 1 }, beforeMidnight)).ok).toBe(false);
    expect(await ledger.headroom(key, { rpd: 1 }, beforeMidnight + 2 * MINUTE)).toEqual({
      ok: true,
    });
  });

  test('token limits are counted separately from request limits', async () => {
    const ledger = await tempLedger();
    const key = bucketKey('cerebras', 'default');
    await ledger.recordTokens(key, 5_000, NOON);

    expect(await ledger.headroom(key, { tpm: 10_000 }, NOON)).toEqual({ ok: true });
    const spent = await ledger.headroom(key, { tpm: 5_000 }, NOON);
    expect(spent.ok).toBe(false);
    if (spent.ok) throw new Error('expected no headroom');
    expect(spent.reason).toBe('tokens per minute');
  });
});

/**
 * A 429 is the only authoritative statement about a limit anyone gets. The
 * published numbers are estimates that differ per model and go stale, so what
 * actually happened has to be able to narrow them.
 */
describe('learning from a 429', () => {
  test('parks the account for the interval the provider asked for', async () => {
    const ledger = await tempLedger();
    const key = bucketKey('groq', 'default');
    await ledger.recordRateLimit(key, 30_000, NOON);

    const room = await ledger.headroom(key, { rpm: 1000 }, NOON + 1_000);
    expect(room.ok).toBe(false);
    if (room.ok) throw new Error('expected a cooldown');
    expect(room.retryAt).toBe(NOON + 30_000);

    // Once the interval the provider named has passed, the account is offered
    // again - a cooldown is a pause, not a write-off.
    expect(await ledger.headroom(key, { rpm: 1000 }, NOON + 31_000)).toEqual({ ok: true });
  });

  test('narrows the believed ceiling below what was counted', async () => {
    const ledger = await tempLedger();
    const key = bucketKey('groq', 'default');
    for (let i = 0; i < 12; i++) await ledger.reserve(key, NOON);
    await ledger.recordRateLimit(key, 1_000, NOON);

    // Past the cooldown, but the table's optimistic 30/min no longer applies:
    // the refusal at 12 proves the real ceiling is at most 11.
    const later = NOON + 5_000;
    const room = await ledger.headroom(key, { rpm: 30 }, later);
    expect(room.ok).toBe(false);
    if (room.ok) throw new Error('expected the learned limit to apply');
    expect(room.reason).toBe('requests per minute');
  });

  test('a long Retry-After is read as a daily ceiling, not a per-minute one', async () => {
    const ledger = await tempLedger();
    const key = bucketKey('google', 'default');
    for (let i = 0; i < 4; i++) await ledger.reserve(key, NOON);
    await ledger.recordRateLimit(key, 2 * 60 * 60 * 1000, NOON);

    const buckets = await ledger.read();
    expect(buckets[key]?.learned?.rpd).toBe(3);
    expect(buckets[key]?.learned?.rpm).toBeUndefined();
  });
});

describe('the ledger file', () => {
  test('survives a reload and keeps counts per account', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'earshot-pool-'));
    const path = join(dir, 'ledger.json');
    const ledger = new QuotaLedger(path);
    await ledger.reserve(bucketKey('groq', 'default'), NOON);
    await ledger.reserve(bucketKey('groq', 'work'), NOON);
    await ledger.reserve(bucketKey('groq', 'work'), NOON);

    const reopened = await new QuotaLedger(path).read();
    expect(reopened[bucketKey('groq', 'default')]?.minute.requests).toBe(1);
    expect(reopened[bucketKey('groq', 'work')]?.minute.requests).toBe(2);
  });

  /**
   * Losing the ledger costs one wasted request, so anything unreadable is
   * discarded rather than surfaced. Refusing to start because a cache file is
   * corrupt would be a far worse failure than recounting from zero.
   */
  test('a corrupt or foreign file is discarded, not fatal', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'earshot-pool-'));
    const path = join(dir, 'ledger.json');
    await writeFile(path, 'not json at all');
    expect(await new QuotaLedger(path).read()).toEqual({});

    await writeFile(path, JSON.stringify({ version: 99, buckets: { x: {} } }));
    expect(await new QuotaLedger(path).read()).toEqual({});
  });

  test('concurrent writers do not lose each other’s counts', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'earshot-pool-'));
    const path = join(dir, 'ledger.json');
    const key = bucketKey('groq', 'default');
    // Separate instances stand in for separate earshot processes: each holds no
    // cached copy, so a lost update would show up as a count below 20.
    await Promise.all(Array.from({ length: 20 }, () => new QuotaLedger(path).reserve(key, NOON)));

    const buckets = JSON.parse(await readFile(path, 'utf8')).buckets as Record<
      string,
      { minute: { requests: number } }
    >;
    expect(buckets[key]?.minute.requests).toBe(20);
  });

  test('a writer that times out does not remove another writer’s lock', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'earshot-pool-'));
    const path = join(dir, 'ledger.json');
    const lock = `${path}.lock`;
    await mkdir(lock);

    await new QuotaLedger(path, 0).reserve(bucketKey('groq', 'default'), NOON);

    await access(lock);
  });

  test('clear forgets one account without touching the others', async () => {
    const ledger = await tempLedger();
    await ledger.reserve(bucketKey('groq', 'default'), NOON);
    await ledger.reserve(bucketKey('cerebras', 'default'), NOON);
    await ledger.clear(bucketKey('groq', 'default'));

    const buckets = await ledger.read();
    expect(buckets[bucketKey('groq', 'default')]).toBeUndefined();
    expect(buckets[bucketKey('cerebras', 'default')]?.minute.requests).toBe(1);
  });
});
