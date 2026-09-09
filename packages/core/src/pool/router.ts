import {
  type EarshotError,
  errorFromStatus,
  type ModelRequest,
  type PoolCandidate,
  QuotaLedger,
  type StreamEvent,
} from '@earshot/providers';
import { estimateTokens } from '../context/shapers.ts';
import { portableFor } from './portable.ts';

/**
 * Routing across pooled free providers.
 *
 * The router's first job is to *not* make a request: it asks the ledger for an
 * account with headroom before opening a stream, so a tier already spent costs
 * nothing rather than a failed round trip. Its second job is to survive being
 * wrong about that, because local counting cannot see requests made by other
 * tools using the same key.
 *
 * What it deliberately does not do is switch providers mid-stream. Once a token
 * has been forwarded the assistant message for this step is partly committed;
 * swapping under it would splice two models' output into one message. A failure
 * after that point ends the step, and the next step of the agent loop picks a
 * fresh candidate with the whole history intact.
 */

export interface RouterOptions {
  ledger?: QuotaLedger;
  /** Injectable for tests; real backoff would make them slow for no benefit. */
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

/** Backoff before retrying the same account. Short: a turn is interactive. */
const BACKOFF_MS = [250, 1_000];

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export interface PoolRouteContext {
  candidates: readonly PoolCandidate[];
  /** Opens one stream against one candidate. Supplied by `streamModel`. */
  open: (candidate: PoolCandidate, request: ModelRequest) => AsyncIterable<StreamEvent>;
}

export async function* routePooled(
  ctx: PoolRouteContext,
  request: Omit<ModelRequest, 'modelId'>,
  opts: RouterOptions = {},
): AsyncIterable<StreamEvent> {
  const ledger = opts.ledger ?? new QuotaLedger();
  const sleep = opts.sleep ?? defaultSleep;
  const now = opts.now ?? Date.now;

  const needed = estimateTokens([...request.messages], request.system ?? '');
  /** Accounts a provider has actively rejected. A bad key does not improve. */
  const rejected = new Set<string>();
  const blocked: Array<{ candidate: PoolCandidate; reason: string; retryAt: number }> = [];
  let lastError: EarshotError | undefined;
  /** What we walked past to get here, and why. Empty on the first candidate. */
  let left: { candidate: PoolCandidate; reason: string } | undefined;

  for (const candidate of ctx.candidates) {
    if (rejected.has(candidate.bucket)) continue;

    // A candidate whose window cannot hold the conversation is not a fallback,
    // it is a guaranteed context overflow. Better to skip it than to spend a
    // request discovering that.
    if (candidate.model.contextWindow <= needed) {
      blocked.push({ candidate, reason: 'context too small', retryAt: 0 });
      left = { candidate, reason: `${candidate.provider.id}'s context is too small` };
      continue;
    }

    const room = await ledger.headroom(candidate.bucket, candidate.limits, now());
    if (!room.ok) {
      blocked.push({ candidate, reason: room.reason, retryAt: room.retryAt });
      left = { candidate, reason: `${candidate.provider.id} is out of ${room.reason}` };
      continue;
    }

    // Announced before the request, not after: the point of saying so is that
    // the user knows which model is answering while it answers.
    if (left) {
      yield {
        type: 'switched',
        providerId: candidate.provider.id,
        modelId: candidate.model.id,
        reason: left.reason,
      };
    }

    const outcome = yield* attempt(ctx, candidate, request, { ledger, sleep, now });
    if (outcome.done) return;
    if (outcome.error) lastError = outcome.error;
    if (outcome.rejected) rejected.add(candidate.bucket);
    left = { candidate, reason: describe(candidate, outcome.error) };
  }

  yield { type: 'error', error: exhausted(blocked, lastError, now()) };
}

interface Attempt {
  /** The stream ran far enough that switching is no longer safe. */
  done: boolean;
  error?: EarshotError;
  rejected?: boolean;
}

/**
 * One candidate, retried in place before the router moves on.
 *
 * Retrying the same account first is worth two short waits: a 429 with a
 * `Retry-After` of a second, or a transient 5xx, resolves far faster than
 * failing over to a weaker model would.
 */
async function* attempt(
  ctx: PoolRouteContext,
  candidate: PoolCandidate,
  request: Omit<ModelRequest, 'modelId'>,
  deps: { ledger: QuotaLedger; sleep: (ms: number) => Promise<void>; now: () => number },
): AsyncGenerator<StreamEvent, Attempt> {
  const { ledger, sleep, now } = deps;

  for (let tries = 0; ; tries++) {
    const messages = portableFor(candidate.provider.id, request.messages);
    await ledger.reserve(candidate.bucket, now());

    let emitted = false;
    let failure: EarshotError | undefined;

    for await (const event of ctx.open(candidate, {
      ...request,
      messages,
      modelId: candidate.model.id,
    })) {
      if (event.type === 'error') {
        failure = event.error;
        break;
      }
      if (event.type === 'usage') {
        await ledger.recordTokens(
          candidate.bucket,
          event.usage.inputTokens + event.usage.outputTokens,
          now(),
        );
      }
      emitted = true;
      yield event;
    }

    if (!failure) return { done: true };

    if (failure.kind === 'rate_limit') {
      await ledger.recordRateLimit(candidate.bucket, retryAfterOf(failure), now());
    }

    // Past the first forwarded event the step belongs to this model: its partial
    // message is already in the caller's hands, so the failure is the caller's
    // to end the step on. The next step re-enters the router from a clean start.
    if (emitted) {
      yield { type: 'error', error: failure };
      return { done: true };
    }

    // An abort is the user, not the provider. Nothing else should be tried.
    if (failure.kind === 'abort') {
      yield { type: 'error', error: failure };
      return { done: true };
    }

    if (failure.kind === 'auth') return { done: false, error: failure, rejected: true };

    const backoff = BACKOFF_MS[tries];
    if (backoff === undefined || !failure.retryable) {
      return { done: false, error: failure };
    }
    await sleep(backoff);
  }
}

/** Why we left the previous candidate, in the few words a notice line has room for. */
function describe(previous: PoolCandidate, error: EarshotError | undefined): string {
  if (error?.kind === 'auth') return `${previous.provider.id} rejected its key`;
  if (error?.kind === 'rate_limit') return `${previous.provider.id} is rate limited`;
  if (error) return `${previous.provider.id} failed (${error.kind})`;
  return `${previous.provider.id} has no quota left`;
}

/** `Retry-After` is the one rate-limit header every vendor actually agrees on. */
function retryAfterOf(error: EarshotError): number | undefined {
  const cause = error.cause as { retryAfterMs?: number; retryAfter?: number } | undefined;
  if (typeof cause?.retryAfterMs === 'number') return cause.retryAfterMs;
  if (typeof cause?.retryAfter === 'number') return cause.retryAfter * 1_000;
  const seconds = /retry[- ]after[^0-9]{0,4}(\d+)/i.exec(error.message)?.[1];
  return seconds ? Number(seconds) * 1_000 : undefined;
}

/**
 * The message a user sees when the pool is spent.
 *
 * It names when the soonest account comes back, because "try again later" is
 * not actionable and the ledger already knows the answer.
 */
function exhausted(
  blocked: Array<{ candidate: PoolCandidate; reason: string; retryAt: number }>,
  lastError: EarshotError | undefined,
  now: number,
): EarshotError {
  if (blocked.length === 0) {
    return (
      lastError ??
      errorFromStatus(0, 'no free provider could serve this request', { kind: 'unknown' })
    );
  }

  const soonest = blocked
    .filter((one) => one.retryAt > now)
    .sort((a, b) => a.retryAt - b.retryAt)[0];
  const detail = soonest
    ? `${soonest.candidate.provider.id} (${soonest.reason}) frees up in ${humanise(soonest.retryAt - now)}`
    : blocked.map((one) => `${one.candidate.provider.id} (${one.reason})`).join(', ');

  return {
    kind: 'rate_limit',
    message: `every free provider is spent: ${detail}. run \`earshot pool status\` for the full picture`,
    // Not retryable in the sense the loop means it: retrying now fails again,
    // and the user has a real choice to make - wait, or use a paid model.
    retryable: false,
  };
}

function humanise(ms: number): string {
  const minutes = Math.ceil(ms / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h${minutes % 60 ? ` ${minutes % 60}m` : ''}`;
}
