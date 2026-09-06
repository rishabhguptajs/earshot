import { resolveModel, streamModel } from '@earshot/core';
import {
  type AuthSpec,
  AuthStore,
  buildRegistry,
  loginToOpenRouter,
  type Provider,
  resolveCredentials,
} from '@earshot/providers';
import type { OnboardingOptions, OnboardingProvider, ProbeResult } from '@earshot/tui';

/**
 * Turns the provider registry and auth store into what `Onboarding` needs.
 *
 * Kept out of packages/tui deliberately: the component takes plain callbacks so
 * it can be driven in tests with no registry and no network, and this is the
 * one place that binds it to the real one.
 */
export async function buildOnboardingOptions(
  wanted?: string,
  wantedModel?: string,
): Promise<OnboardingOptions> {
  const registry = buildRegistry();
  const store = new AuthStore();

  const providers: OnboardingProvider[] = [];
  for (const provider of registry.list()) {
    if (provider.auth.kind === 'none') continue;
    providers.push(await describe(provider, store));
  }
  // OAuth first: signing in needs nothing typed, which is the easiest way for
  // someone who has never used earshot before to get past this screen.
  providers.sort((a, b) => Number(b.kind === 'oauth') - Number(a.kind === 'oauth'));

  return {
    providers,
    ...(wanted ? { wanted } : {}),
    ...(wantedModel ? { wantedModel } : {}),
    storeKey: (providerId, key) => store.set(providerId, { type: 'api-key', apiKey: key }),
    forgetKey: (providerId) => store.remove(providerId),
    signIn: async (providerId, onUrl) => {
      const credentials = await loginToOpenRouter({ onUrl });
      await store.set(providerId, credentials);
    },
    probe: (providerId, modelId) => probe(registry, providerId, modelId),
  };
}

async function describe(provider: Provider, store: AuthStore): Promise<OnboardingProvider> {
  const configured = await resolveCredentials(provider, { store }).catch(() => undefined);
  return {
    id: provider.id,
    models: provider.models().map((model) => ({ id: model.id, name: model.name })),
    kind: provider.auth.kind === 'oauth' ? 'oauth' : 'api-key',
    ...(envVarsOf(provider.auth).length ? { envVars: envVarsOf(provider.auth) } : {}),
    ...(configured ? { configured: describeConfigured(configured.type) } : {}),
  };
}

function envVarsOf(auth: AuthSpec): string[] {
  return auth.kind === 'api-key' || auth.kind === 'oauth' ? (auth.envVars ?? []) : [];
}

function describeConfigured(kind: 'ambient' | 'oauth' | 'api-key'): string {
  return kind === 'ambient'
    ? 'ambient credentials'
    : kind === 'oauth'
      ? 'signed in'
      : 'api key set';
}

/**
 * One minimal live call, spending a fraction of a cent to prove the credential
 * actually works. Structural validation (a non-empty string) tells you nothing
 * a provider could not reject a second later on the user's first real turn.
 */
async function probe(
  registry: ReturnType<typeof buildRegistry>,
  providerId: string,
  modelId: string,
): Promise<ProbeResult> {
  const listed = registry.list().find((provider) => provider.id === providerId);
  if (!listed) return { ok: false, reason: 'other', message: `unknown provider "${providerId}"` };

  const model = listed.models().find((candidate) => candidate.id === modelId);
  if (!model) {
    return {
      ok: false,
      reason: 'other',
      message: `${providerId} does not publish model "${modelId}"`,
    };
  }

  let resolved: Awaited<ReturnType<typeof resolveModel>>;
  try {
    resolved = await resolveModel(registry, `${providerId}/${model.id}`);
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
      // The first event of any kind proves the request round-tripped; nothing
      // further needs spending.
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
    const message = (error as Error).message;
    const timedOut = controller.signal.aborted && (error as Error).name === 'AbortError';
    return timedOut
      ? { ok: false, reason: 'unreachable', message: 'timed out waiting for a response' }
      : { ok: false, reason: 'other', message };
  } finally {
    clearTimeout(timeout);
  }
}
