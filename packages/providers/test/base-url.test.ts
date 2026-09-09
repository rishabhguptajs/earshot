import { describe, expect, test } from 'bun:test';
import { expandBaseUrl, templatedBaseUrl } from '../src/base-url.ts';

/**
 * Most providers are a fixed host plus a key. A few - Cloudflare Workers AI -
 * put the account in the path, which makes the endpoint a property of the
 * credential rather than of the provider, and makes it different for each
 * pooled account of the same vendor.
 */
describe('base url expansion', () => {
  // biome-ignore lint/suspicious/noTemplateCurlyInString: the placeholder under test
  const template = 'https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/ai/v1';

  test('leaves an ordinary base url alone', () => {
    expect(expandBaseUrl('https://api.groq.com/openai/v1', undefined, {})).toBe(
      'https://api.groq.com/openai/v1',
    );
    expect(templatedBaseUrl('https://api.groq.com/openai/v1')).toBe(false);
    expect(templatedBaseUrl(template)).toBe(true);
  });

  test('fills the placeholder from the credential', () => {
    const url = expandBaseUrl(
      template,
      { type: 'api-key', apiKey: 'k', extra: { CLOUDFLARE_ACCOUNT_ID: 'acct123' } },
      {},
    );
    expect(url).toBe('https://api.cloudflare.com/client/v4/accounts/acct123/ai/v1');
  });

  test('falls back to the environment, so a key that predates the pool still works', () => {
    const url = expandBaseUrl(template, { type: 'api-key', apiKey: 'k' }, {
      CLOUDFLARE_ACCOUNT_ID: 'from-env',
    } as NodeJS.ProcessEnv);
    expect(url).toBe('https://api.cloudflare.com/client/v4/accounts/from-env/ai/v1');
  });

  /**
   * Two accounts of one vendor are two URLs. Reading the value off the
   * environment when the credential has its own would silently send one
   * account's key to the other's endpoint.
   */
  test('the credential wins over the environment', () => {
    const url = expandBaseUrl(
      template,
      { type: 'api-key', apiKey: 'k', extra: { CLOUDFLARE_ACCOUNT_ID: 'mine' } },
      { CLOUDFLARE_ACCOUNT_ID: 'someone-elses' } as NodeJS.ProcessEnv,
    );
    expect(url).toBe('https://api.cloudflare.com/client/v4/accounts/mine/ai/v1');
  });

  /**
   * Left unresolved this is a 404 against a URL with a literal `${...}` in it,
   * which tells the user nothing about what to do next.
   */
  test('names what is missing rather than calling a broken url', () => {
    expect(() => expandBaseUrl(template, { type: 'api-key', apiKey: 'k' }, {})).toThrow(
      /CLOUDFLARE_ACCOUNT_ID/,
    );
    expect(() => expandBaseUrl(template, undefined, {})).toThrow(/earshot pool setup/);
  });

  test('ignores a non-string value stored under the name', () => {
    expect(() =>
      expandBaseUrl(
        template,
        { type: 'api-key', apiKey: 'k', extra: { CLOUDFLARE_ACCOUNT_ID: 7 } },
        {},
      ),
    ).toThrow(/CLOUDFLARE_ACCOUNT_ID/);
  });
});
