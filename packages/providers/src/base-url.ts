import type { Credentials } from './types.ts';

/**
 * Fills `${NAME}` placeholders in a provider base URL.
 *
 * Most vendors address themselves with a fixed host and identify the caller
 * entirely by the key. A few - Cloudflare Workers AI, Azure - put part of the
 * account in the path, which means the endpoint is not knowable until a
 * credential is chosen. That is a per-*account* fact, not a per-provider one:
 * two pooled Cloudflare accounts are two different URLs, so this resolves
 * against the credential first and only then falls back to the environment.
 *
 * Left unresolved this fails at the wire with a 404 against a URL containing a
 * literal `${...}`, which tells the user nothing, so a missing value throws
 * here and names what is missing.
 */
export function expandBaseUrl(
  baseUrl: string,
  credentials?: Credentials,
  env: NodeJS.ProcessEnv = process.env,
): string {
  if (!baseUrl.includes('${')) return baseUrl;
  return baseUrl.replace(/\$\{(\w+)\}/g, (_match, name: string) => {
    const stored = credentials?.extra?.[name];
    const value = (typeof stored === 'string' ? stored : undefined) ?? env[name];
    if (!value) {
      throw new Error(
        `this provider's endpoint needs ${name}: set it in the environment, ` +
          'or re-run `earshot pool setup` to store it with the key.',
      );
    }
    return value;
  });
}

/** Whether a base URL still needs values before it can be called. */
export const templatedBaseUrl = (baseUrl: string | undefined): boolean =>
  baseUrl?.includes('${') ?? false;
