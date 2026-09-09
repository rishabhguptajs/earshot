import { describe, expect, test } from 'bun:test';
import type { Model, Provider, StreamEvent, WireApi, WireContext } from '@earshot/providers';
import { ProviderRegistry } from '@earshot/providers';
import { MissingCredentialsError, resolveModel, streamModel } from '../src/model.ts';

/**
 * Cloudflare Workers AI names the account in its URL path, so the endpoint is a
 * property of the credential. This is the check that the value actually reaches
 * the wire: it is invisible until a request 404s against a URL with a literal
 * `${...}` in it, which is exactly the failure that is hard to read.
 */
function fixture() {
  const seen: Array<string | undefined> = [];
  const wire: WireApi = {
    kind: 'openai-completions',
    async *stream(_req, ctx: WireContext): AsyncIterable<StreamEvent> {
      seen.push(ctx.baseUrl);
      const usage = { inputTokens: 1, outputTokens: 1 };
      yield { type: 'finish', reason: 'stop', usage, message: { role: 'assistant', content: [] } };
    },
  };

  const model: Model = {
    id: '@cf/openai/gpt-oss-20b',
    providerId: 'cloudflare',
    name: 'gpt-oss-20b',
    contextWindow: 128_000,
    maxOutputTokens: 8_192,
    capabilities: { tools: true, vision: false, reasoning: false },
    api: 'openai-completions',
  };

  const provider: Provider = {
    id: 'cloudflare',
    name: 'Cloudflare Workers AI',
    auth: { kind: 'api-key', envVars: ['CLOUDFLARE_API_TOKEN'] },
    // biome-ignore lint/suspicious/noTemplateCurlyInString: the placeholder under test
    baseUrl: 'https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/ai/v1',
    api: 'openai-completions',
    models: () => [model],
  };

  const registry = new ProviderRegistry().register(provider).registerWire(wire);
  return { registry, provider, model, seen };
}

const turn = { messages: [{ role: 'user' as const, content: [] }] };

async function drain(stream: AsyncIterable<StreamEvent>): Promise<void> {
  for await (const _event of stream) {
    // Draining is the point; the assertion is on what the wire was handed.
  }
}

describe('a provider whose endpoint names the account', () => {
  test('opens the stream against the account in the credential', async () => {
    const { registry, provider, model, seen } = fixture();
    await drain(
      streamModel(
        registry,
        {
          provider,
          model,
          credentials: { type: 'api-key', apiKey: 'k', extra: { CLOUDFLARE_ACCOUNT_ID: 'acct1' } },
        },
        turn,
      ),
    );
    expect(seen).toEqual(['https://api.cloudflare.com/client/v4/accounts/acct1/ai/v1']);
  });

  /** Two pooled accounts of one vendor are two endpoints, not one. */
  test('gives each pooled account its own endpoint', async () => {
    const { registry, provider, model, seen } = fixture();
    for (const id of ['acct1', 'acct2']) {
      await drain(
        streamModel(
          registry,
          {
            provider,
            model,
            credentials: { type: 'api-key', apiKey: 'k', extra: { CLOUDFLARE_ACCOUNT_ID: id } },
          },
          turn,
        ),
      );
    }
    expect(seen).toEqual([
      'https://api.cloudflare.com/client/v4/accounts/acct1/ai/v1',
      'https://api.cloudflare.com/client/v4/accounts/acct2/ai/v1',
    ]);
  });

  /**
   * A key with no account id is not a usable credential, and saying so at
   * resolve time is what turns a stack trace at request time into the same
   * "here is what to set" message every other missing credential gets.
   */
  test('fails at resolve time, as a missing credential', async () => {
    const { registry } = fixture();
    const promise = resolveModel(registry, 'cloudflare/@cf/openai/gpt-oss-20b', {
      env: { CLOUDFLARE_API_TOKEN: 'k' } as NodeJS.ProcessEnv,
    });
    await expect(promise).rejects.toThrow(MissingCredentialsError);
    await expect(promise).rejects.toThrow(/CLOUDFLARE_ACCOUNT_ID/);
  });

  test('resolves once the account id is there', async () => {
    const { registry } = fixture();
    const resolved = await resolveModel(registry, 'cloudflare/@cf/openai/gpt-oss-20b', {
      env: { CLOUDFLARE_API_TOKEN: 'k', CLOUDFLARE_ACCOUNT_ID: 'acct1' } as NodeJS.ProcessEnv,
    });
    expect(resolved.provider.id).toBe('cloudflare');
  });

  test('refuses to call a url it could not finish', async () => {
    const { registry, provider, model } = fixture();
    const previous = process.env.CLOUDFLARE_ACCOUNT_ID;
    delete process.env.CLOUDFLARE_ACCOUNT_ID;
    try {
      expect(() =>
        streamModel(
          registry,
          { provider, model, credentials: { type: 'api-key', apiKey: 'k' } },
          turn,
        ),
      ).toThrow(/CLOUDFLARE_ACCOUNT_ID/);
    } finally {
      if (previous !== undefined) process.env.CLOUDFLARE_ACCOUNT_ID = previous;
    }
  });
});
