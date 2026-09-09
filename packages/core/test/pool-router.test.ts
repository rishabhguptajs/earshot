import { describe, expect, test } from 'bun:test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  bucketKey,
  type EarshotError,
  type Message,
  type Model,
  type ModelRequest,
  type PoolCandidate,
  type Provider,
  QuotaLedger,
  type StreamEvent,
} from '@earshot/providers';
import { routePooled } from '../src/pool/router.ts';

const NOON = Date.UTC(2026, 0, 15, 12, 30, 30);

function model(providerId: string, id: string, contextWindow = 100_000): Model {
  return {
    id,
    providerId,
    name: id,
    contextWindow,
    maxOutputTokens: 4_096,
    capabilities: { tools: true, vision: false, reasoning: false },
    api: 'openai-completions',
  };
}

function candidate(providerId: string, opts: Partial<PoolCandidate> = {}): PoolCandidate {
  const provider: Provider = {
    id: providerId,
    name: providerId,
    auth: { kind: 'api-key', envVars: [] },
    api: 'openai-completions',
    models: () => [],
  };
  return {
    provider,
    model: model(providerId, `${providerId}-model`),
    credentials: { type: 'api-key', apiKey: 'k' },
    account: 'default',
    bucket: bucketKey(providerId, 'default'),
    limits: { rpm: 30 },
    trainsOnData: false,
    local: false,
    ...opts,
  };
}

/** What one candidate does when it is asked. */
type Script = 'ok' | EarshotError | StreamEvent[];

const rateLimit: EarshotError = {
  kind: 'rate_limit',
  message: 'too many requests, retry-after 2',
  retryable: true,
  status: 429,
};
const authFailure: EarshotError = {
  kind: 'auth',
  message: 'invalid api key',
  retryable: false,
  status: 401,
};

function fakePool(scripts: Record<string, Script | Script[]>) {
  const calls: string[] = [];
  const seen: ModelRequest[] = [];
  const remaining = new Map<string, Script[]>(
    Object.entries(scripts).map(([id, script]) => [id, Array.isArray(script) ? script : [script]]),
  );

  const open = async function* (
    one: PoolCandidate,
    request: ModelRequest,
  ): AsyncIterable<StreamEvent> {
    calls.push(one.provider.id);
    seen.push(request);
    const queue = remaining.get(one.provider.id) ?? ['ok'];
    const next = (queue.length > 1 ? queue.shift() : queue[0]) ?? 'ok';

    if (Array.isArray(next)) {
      yield* next;
      return;
    }
    if (next !== 'ok') {
      yield { type: 'error', error: next };
      return;
    }
    const usage = { inputTokens: 10, outputTokens: 5 };
    yield { type: 'text_delta', text: `hello from ${one.provider.id}` };
    yield { type: 'usage', usage };
    yield {
      type: 'finish',
      reason: 'stop',
      usage,
      message: { role: 'assistant', content: [{ type: 'text', text: 'hi' }] },
    };
  };

  return { open, calls, seen };
}

async function tempLedger() {
  return new QuotaLedger(join(await mkdtemp(join(tmpdir(), 'earshot-router-')), 'ledger.json'));
}

async function drain(stream: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> {
  const events: StreamEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

const request = (
  messages: Message[] = [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
) => ({
  messages,
});

const noSleep = async () => {};

describe('routing across the pool', () => {
  test('uses the first candidate and stops there', async () => {
    const pool = fakePool({ groq: 'ok', cerebras: 'ok' });
    const events = await drain(
      routePooled(
        { candidates: [candidate('groq'), candidate('cerebras')], open: pool.open },
        request(),
        { ledger: await tempLedger(), sleep: noSleep, now: () => NOON },
      ),
    );

    expect(pool.calls).toEqual(['groq']);
    expect(events.at(-1)?.type).toBe('finish');
  });

  /**
   * Retrying the same account first is worth two short waits: a 429 with a
   * one-second window resolves far faster than failing over to a weaker model.
   */
  test('retries the same account before moving on', async () => {
    const pool = fakePool({ groq: [rateLimit, 'ok'] });
    await drain(
      routePooled({ candidates: [candidate('groq')], open: pool.open }, request(), {
        ledger: await tempLedger(),
        sleep: noSleep,
        now: () => NOON,
      }),
    );
    expect(pool.calls).toEqual(['groq', 'groq']);
  });

  test('falls over to the next provider once retries are spent', async () => {
    const pool = fakePool({ groq: rateLimit, cerebras: 'ok' });
    const events = await drain(
      routePooled(
        { candidates: [candidate('groq'), candidate('cerebras')], open: pool.open },
        request(),
        { ledger: await tempLedger(), sleep: noSleep, now: () => NOON },
      ),
    );

    expect(pool.calls).toEqual(['groq', 'groq', 'groq', 'cerebras']);
    expect(events.some((e) => e.type === 'text_delta' && e.text.includes('cerebras'))).toBe(true);
    expect(events.some((e) => e.type === 'error')).toBe(false);
  });

  /** A bad key does not get better, so it is dropped rather than retried. */
  test('an account the provider rejected is abandoned immediately', async () => {
    const pool = fakePool({ groq: authFailure, cerebras: 'ok' });
    await drain(
      routePooled(
        { candidates: [candidate('groq'), candidate('cerebras')], open: pool.open },
        request(),
        { ledger: await tempLedger(), sleep: noSleep, now: () => NOON },
      ),
    );
    expect(pool.calls).toEqual(['groq', 'cerebras']);
  });

  test('an abort is the user, not the provider: nothing else is tried', async () => {
    const abort: EarshotError = { kind: 'abort', message: 'aborted', retryable: false };
    const pool = fakePool({ groq: abort, cerebras: 'ok' });
    const events = await drain(
      routePooled(
        { candidates: [candidate('groq'), candidate('cerebras')], open: pool.open },
        request(),
        { ledger: await tempLedger(), sleep: noSleep, now: () => NOON },
      ),
    );

    expect(pool.calls).toEqual(['groq']);
    expect(events.at(-1)).toEqual({ type: 'error', error: abort });
  });
});

/**
 * Once a token has been forwarded, the assistant message for this step is partly
 * in the caller's hands. Switching under it would splice two models' output into
 * one message, so the failure ends the step and the next one re-enters clean.
 */
describe('the safe boundary', () => {
  test('a failure after the first token is not failed over', async () => {
    const pool = fakePool({
      groq: [
        [
          { type: 'text_delta', text: 'half a th' },
          { type: 'error', error: rateLimit },
        ],
      ],
      cerebras: 'ok',
    });
    const events = await drain(
      routePooled(
        { candidates: [candidate('groq'), candidate('cerebras')], open: pool.open },
        request(),
        { ledger: await tempLedger(), sleep: noSleep, now: () => NOON },
      ),
    );

    expect(pool.calls).toEqual(['groq']);
    expect(events.map((e) => e.type)).toEqual(['text_delta', 'error']);
  });
});

describe('quota is checked before a request, not after', () => {
  test('an account with no headroom is skipped without being called', async () => {
    const ledger = await tempLedger();
    const spent = candidate('groq', { limits: { rpm: 2 } });
    await ledger.reserve(spent.bucket, NOON);
    await ledger.reserve(spent.bucket, NOON);

    const pool = fakePool({ groq: 'ok', cerebras: 'ok' });
    await drain(
      routePooled({ candidates: [spent, candidate('cerebras')], open: pool.open }, request(), {
        ledger,
        sleep: noSleep,
        now: () => NOON,
      }),
    );
    expect(pool.calls).toEqual(['cerebras']);
  });

  test('tokens actually used are counted against the account', async () => {
    const ledger = await tempLedger();
    const pool = fakePool({ groq: 'ok' });
    await drain(
      routePooled({ candidates: [candidate('groq')], open: pool.open }, request(), {
        ledger,
        sleep: noSleep,
        now: () => NOON,
      }),
    );

    const bucket = (await ledger.read())[bucketKey('groq', 'default')];
    expect(bucket?.minute.requests).toBe(1);
    expect(bucket?.minute.tokens).toBe(15);
  });

  /**
   * A window too small for the conversation is not a fallback, it is a
   * guaranteed overflow - and one that would only surface after spending a
   * request to find out.
   */
  test('a candidate that cannot hold the conversation is skipped', async () => {
    const long = 'x'.repeat(40_000);
    const pool = fakePool({ groq: 'ok', cerebras: 'ok' });
    await drain(
      routePooled(
        {
          candidates: [
            candidate('groq', { model: model('groq', 'tiny', 1_000) }),
            candidate('cerebras'),
          ],
          open: pool.open,
        },
        request([{ role: 'user', content: [{ type: 'text', text: long }] }]),
        { ledger: await tempLedger(), sleep: noSleep, now: () => NOON },
      ),
    );
    expect(pool.calls).toEqual(['cerebras']);
  });
});

describe('when the pool is spent', () => {
  test('says which account frees up first and when', async () => {
    const ledger = await tempLedger();
    const groq = candidate('groq', { limits: { rpm: 1 } });
    await ledger.reserve(groq.bucket, NOON);

    const events = await drain(
      routePooled({ candidates: [groq], open: fakePool({}).open }, request(), {
        ledger,
        sleep: noSleep,
        now: () => NOON,
      }),
    );

    const last = events.at(-1);
    expect(last?.type).toBe('error');
    if (last?.type !== 'error') throw new Error('expected an error');
    expect(last.error.kind).toBe('rate_limit');
    expect(last.error.message).toContain('groq');
    expect(last.error.message).toContain('requests per minute');
    expect(last.error.message).toContain('pool status');
    // Retrying now would fail again; the user has a real choice to make.
    expect(last.error.retryable).toBe(false);
  });

  test('a 429 narrows what the ledger believes the ceiling to be', async () => {
    const ledger = await tempLedger();
    const pool = fakePool({ groq: rateLimit });
    await drain(
      routePooled({ candidates: [candidate('groq')], open: pool.open }, request(), {
        ledger,
        sleep: noSleep,
        now: () => NOON,
      }),
    );

    const bucket = (await ledger.read())[bucketKey('groq', 'default')];
    expect(bucket?.cooldownUntil).toBeGreaterThan(NOON);
    // "retry-after 2" in the message, read as seconds.
    expect(bucket?.cooldownUntil).toBe(NOON + 2_000);
  });
});

/**
 * A session that silently changed model halfway is one where odd output has no
 * explanation. The swap is announced before the request rather than after, so
 * the user knows which model is answering while it answers.
 */
describe('announcing a swap', () => {
  test('says what was left behind and why', async () => {
    const pool = fakePool({ groq: rateLimit, cerebras: 'ok' });
    const events = await drain(
      routePooled(
        { candidates: [candidate('groq'), candidate('cerebras')], open: pool.open },
        request(),
        { ledger: await tempLedger(), sleep: noSleep, now: () => NOON },
      ),
    );

    const switched = events.find((event) => event.type === 'switched');
    expect(switched).toBeDefined();
    if (switched?.type !== 'switched') throw new Error('expected a switch');
    expect(switched.providerId).toBe('cerebras');
    expect(switched.reason).toBe('groq is rate limited');
    // Before any content from the new model, so a consumer can relabel first.
    expect(events.indexOf(switched)).toBeLessThan(
      events.findIndex((event) => event.type === 'text_delta'),
    );
  });

  test('an account skipped on quota is reported too, not silently passed over', async () => {
    const ledger = await tempLedger();
    const spent = candidate('groq', { limits: { rpm: 1 } });
    await ledger.reserve(spent.bucket, NOON);

    const pool = fakePool({ cerebras: 'ok' });
    const events = await drain(
      routePooled({ candidates: [spent, candidate('cerebras')], open: pool.open }, request(), {
        ledger,
        sleep: noSleep,
        now: () => NOON,
      }),
    );

    const switched = events.find((event) => event.type === 'switched');
    if (switched?.type !== 'switched') throw new Error('expected a switch');
    expect(switched.reason).toContain('groq is out of requests per minute');
  });

  test('the first candidate is not a switch', async () => {
    const pool = fakePool({ groq: 'ok' });
    const events = await drain(
      routePooled({ candidates: [candidate('groq')], open: pool.open }, request(), {
        ledger: await tempLedger(),
        sleep: noSleep,
        now: () => NOON,
      }),
    );
    expect(events.some((event) => event.type === 'switched')).toBe(false);
  });

  test('a key the provider rejected is named as such', async () => {
    const pool = fakePool({ groq: authFailure, cerebras: 'ok' });
    const events = await drain(
      routePooled(
        { candidates: [candidate('groq'), candidate('cerebras')], open: pool.open },
        request(),
        { ledger: await tempLedger(), sleep: noSleep, now: () => NOON },
      ),
    );

    const switched = events.find((event) => event.type === 'switched');
    if (switched?.type !== 'switched') throw new Error('expected a switch');
    expect(switched.reason).toBe('groq rejected its key');
  });
});
