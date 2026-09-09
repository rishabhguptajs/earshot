import {
  loadSettings,
  POOL_DEFAULT_MODEL,
  persistDefaultModel,
  persistPool,
  resolveModel,
  streamModel,
} from '@earshot/core';
import {
  AuthStore,
  buildRegistry,
  DEFAULT_ACCOUNT,
  FREE_TIERS,
  LOCAL_TIERS,
  POOL_TIERS,
  poolCandidates,
  QuotaLedger,
  type QuotaLimits,
} from '@earshot/providers';
import type {
  PoolOptionsBinding,
  PoolProviderOption,
  PoolSetupOptions,
  ProbeResult,
} from '@earshot/tui';

/**
 * Binds the free-tier table and the auth store to the setup wizard.
 *
 * Kept out of packages/tui for the same reason `onboard.ts` is: the component
 * takes plain callbacks so it can be driven in tests with no registry and no
 * network, and this is the one place that wires it to the real ones.
 */
export async function buildPoolSetupOptions(cwd = process.cwd()): Promise<PoolSetupOptions> {
  const store = new AuthStore();
  const providers: PoolProviderOption[] = [];

  for (const tier of FREE_TIERS) {
    // Local runtimes have nothing to connect - no key, no account, no signup.
    if (LOCAL_TIERS.has(tier.providerId)) continue;
    providers.push({
      id: tier.providerId,
      label: tier.label,
      signupUrl: tier.signupUrl,
      limits: describeLimits(tier.limits),
      trainsOnData: tier.trainsOnData,
      accounts: (await store.listAccounts(tier.providerId)).map((one) => one.account),
    });
  }

  return {
    providers,
    storeKey: (providerId, account, key) =>
      store.setAccount(providerId, account, { type: 'api-key', apiKey: key }),
    forgetKey: (providerId, account) => store.removeAccount(providerId, account),
    probe: (providerId) => probe(providerId, store),
    openUrl: (url) => void openInBrowser(url),
    finish: async () => {
      await persistPool({ enabled: true }, 'global', cwd);
      return persistDefaultModel(POOL_DEFAULT_MODEL, 'global', cwd);
    },
  };
}

/** Everything `/pool` needs, with the vendor knowledge kept on this side of it. */
export async function buildPoolBinding(cwd = process.cwd()): Promise<PoolOptionsBinding> {
  return {
    status: () => poolStatusText(cwd),
    setEnabled: (on) => persistPool({ enabled: on }, 'global', cwd),
    setup: await buildPoolSetupOptions(cwd),
  };
}

/** Whether any free account is connected - what decides the first-run default. */
export async function poolIsConnected(cwd = process.cwd()): Promise<boolean> {
  const settings = await loadSettings(cwd);
  if (!settings.pool.enabled) return false;
  const registry = buildRegistry();
  return (await poolCandidates(registry, 'best')).length > 0;
}

function describeLimits(limits: QuotaLimits): string {
  const parts: string[] = [];
  if (limits.rpd) parts.push(`${limits.rpd.toLocaleString('en-US')} requests/day`);
  else if (limits.rpm) parts.push(`${limits.rpm}/min`);
  if (limits.tpm) parts.push(`${(limits.tpm / 1000).toLocaleString('en-US')}k tokens/min`);
  return parts.length ? `free · ${parts.join(', ')}` : 'free';
}

/**
 * One minimal live call against whichever free model this provider offers.
 *
 * Structural validation - a non-empty string - proves nothing a provider could
 * not reject a second later on the user's first real turn, and finding that out
 * mid-conversation is exactly what the wizard exists to prevent.
 */
async function probe(providerId: string, store: AuthStore): Promise<ProbeResult> {
  const registry = buildRegistry();
  const candidates = (
    await Promise.all(
      (['cheap', 'fast', 'best'] as const).map((tier) => poolCandidates(registry, tier, { store })),
    )
  ).flat();
  const candidate = candidates.find((one) => one.provider.id === providerId);
  if (!candidate) {
    return { ok: false, reason: 'other', message: `${providerId} has no free model in the table` };
  }

  let resolved: Awaited<ReturnType<typeof resolveModel>>;
  try {
    resolved = await resolveModel(registry, `${providerId}/${candidate.model.id}`);
  } catch (error) {
    return { ok: false, reason: 'other', message: (error as Error).message };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  try {
    for await (const event of streamModel(registry, resolved, {
      system: 'Reply with one word.',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      maxOutputTokens: 1,
      abortSignal: controller.signal,
    })) {
      // The first event of any kind proves the request round-tripped.
      controller.abort();
      if (event.type === 'error') {
        return event.error.kind === 'auth'
          ? { ok: false, reason: 'rejected', message: event.error.message }
          : event.error.kind === 'network'
            ? { ok: false, reason: 'unreachable', message: event.error.message }
            : { ok: false, reason: 'other', message: event.error.message };
      }
      return { ok: true };
    }
    return { ok: true };
  } catch (error) {
    const timedOut = controller.signal.aborted && (error as Error).name === 'AbortError';
    return timedOut
      ? { ok: false, reason: 'unreachable', message: 'timed out waiting for a response' }
      : { ok: false, reason: 'other', message: (error as Error).message };
  } finally {
    clearTimeout(timeout);
  }
}

async function openInBrowser(url: string): Promise<void> {
  const { platform } = await import('node:os');
  const { spawn } = await import('node:child_process');
  const command = platform() === 'darwin' ? 'open' : platform() === 'win32' ? 'cmd' : 'xdg-open';
  const args = platform() === 'win32' ? ['/c', 'start', '', url] : [url];
  try {
    spawn(command, args, { stdio: 'ignore', detached: true }).unref();
  } catch {
    // No browser to open - the URL is on screen either way, which is the point
    // of printing it rather than only launching it.
  }
}

/**
 * What is connected, what is left, and when the spent ones come back.
 *
 * Cost stops being the meaningful number in a pooled session - everything in it
 * is free - so quota is the budget, and this is where you read it.
 */
export async function poolStatusText(cwd: string): Promise<string> {
  const settings = await loadSettings(cwd);
  const store = new AuthStore();
  const ledger = new QuotaLedger();
  const buckets = await ledger.read();
  const now = Date.now();
  const out: string[] = [];

  out.push(settings.pool.enabled ? 'pool: on' : 'pool: off  (earshot pool enable)');
  if (settings.pool.excludeTrainingProviders) {
    out.push('excluding providers that train on submitted data');
  }
  out.push('');

  let connected = 0;
  for (const tier of FREE_TIERS) {
    const local = LOCAL_TIERS.has(tier.providerId);
    const accounts = await store.listAccounts(tier.providerId);
    if (accounts.length === 0 && !local) {
      out.push(`${tier.providerId.padEnd(16)} ${'-'.padEnd(30)} not connected`);
      continue;
    }
    if (local) {
      out.push(`${tier.providerId.padEnd(16)} ${'local'.padEnd(30)} no quota`);
      continue;
    }

    for (const account of accounts) {
      connected++;
      const key = `${tier.providerId}#${account.account}`;
      const bucket = buckets[key];
      const label =
        account.account === DEFAULT_ACCOUNT
          ? tier.providerId
          : `${tier.providerId}#${account.account}`;
      out.push(
        `${label.padEnd(16)} ${spend(bucket, tier.limits).padEnd(30)} ${when(bucket, now)}` +
          (tier.trainsOnData ? '  · trains on your data' : ''),
      );
    }
  }

  if (connected === 0) {
    out.push('', 'nothing is connected yet. run `earshot pool setup` to add a free provider.');
  } else {
    // Which concrete model each tier resolves to right now is the question
    // "what am I actually running on?", and it is not answerable from the table.
    const registry = buildRegistry();
    out.push('');
    for (const tier of POOL_TIERS) {
      const candidates = await poolCandidates(registry, tier, { store });
      const first = candidates[0];
      out.push(
        `free/${tier.padEnd(6)} ${first ? `${first.provider.id}/${first.model.id}` : 'nothing available'}` +
          (candidates.length > 1 ? `  (+${candidates.length - 1} more)` : ''),
      );
    }
  }

  return out.join('\n');
}

function spend(
  bucket: { minute: { requests: number }; day: { requests: number } } | undefined,
  limits: { rpm?: number; rpd?: number },
): string {
  const day = bucket?.day.requests ?? 0;
  const minute = bucket?.minute.requests ?? 0;
  const perDay = limits.rpd ? `${day}/${limits.rpd} today` : `${day} today`;
  return limits.rpm ? `${perDay}, ${minute}/${limits.rpm} this min` : perDay;
}

function when(bucket: { cooldownUntil?: number } | undefined, now: number): string {
  const until = bucket?.cooldownUntil;
  if (!until || until <= now) return 'ready';
  const minutes = Math.ceil((until - now) / 60_000);
  return `rate limited, back in ${minutes}m`;
}
