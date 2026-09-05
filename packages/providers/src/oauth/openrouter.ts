import { spawn } from 'node:child_process';
import { platform } from 'node:os';
import type { Credentials } from '../types.ts';
import { listenForCallback } from './loopback.ts';
import { createPkcePair, type PkcePair } from './pkce.ts';

const AUTH_URL = 'https://openrouter.ai/auth';
const EXCHANGE_URL = 'https://openrouter.ai/api/v1/auth/keys';

export class OAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OAuthError';
  }
}

export function authorizeUrl(redirectUri: string, pkce: PkcePair): string {
  const url = new URL(AUTH_URL);
  url.searchParams.set('callback_url', redirectUri);
  url.searchParams.set('code_challenge', pkce.challenge);
  url.searchParams.set('code_challenge_method', pkce.method);
  return url.toString();
}

/**
 * Trades the authorisation code for an OpenRouter key.
 *
 * OpenRouter's PKCE flow hands back a normal API key rather than a
 * refreshable token, so what gets stored is `api-key` credentials like any
 * other - there is no refresh path to get wrong, and revoking it is something
 * the user does on their own dashboard rather than something earshot manages.
 */
export async function exchangeCode(
  code: string,
  pkce: PkcePair,
  doFetch: typeof fetch = fetch,
): Promise<Credentials> {
  const response = await doFetch(EXCHANGE_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      code,
      code_verifier: pkce.verifier,
      code_challenge_method: pkce.method,
    }),
  }).catch((error: Error) => {
    throw new OAuthError(`could not reach OpenRouter: ${error.message}`);
  });

  const body = (await response.json().catch(() => undefined)) as { key?: unknown } | undefined;
  if (!response.ok) {
    throw new OAuthError(
      `OpenRouter refused the code (${response.status}). Start again with \`earshot auth login openrouter\`.`,
    );
  }
  if (typeof body?.key !== 'string' || body.key === '') {
    throw new OAuthError('OpenRouter returned no key');
  }
  return { type: 'api-key', apiKey: body.key };
}

export interface LoginOptions {
  /** Called with the URL, so a caller can print it as well as open it. */
  onUrl?: (url: string) => void;
  openBrowser?: boolean;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

/**
 * The whole flow: bind a loopback port, send the user to OpenRouter, wait for
 * the redirect, exchange the code.
 *
 * The URL is always printed, not only opened. A browser that fails to launch -
 * over SSH, in a container, on a machine with no default handler - is the
 * common case for a terminal tool, and a flow that only opens one leaves the
 * user with nothing to do.
 */
export async function loginToOpenRouter(options: LoginOptions = {}): Promise<Credentials> {
  const pkce = createPkcePair();
  const listener = await listenForCallback(options.timeoutMs ?? 300_000);

  try {
    const url = authorizeUrl(listener.redirectUri, pkce);
    options.onUrl?.(url);
    if (options.openBrowser !== false) openBrowser(url);

    const params = await listener.code;
    const code = params.get('code');
    if (!code) throw new OAuthError('OpenRouter came back without an authorisation code');
    return await exchangeCode(code, pkce, options.fetch ?? fetch);
  } finally {
    listener.close();
  }
}

/** Best effort, and deliberately not awaited: the flow does not depend on it. */
function openBrowser(url: string): void {
  const [command, args] =
    platform() === 'darwin'
      ? ['open', [url]]
      : platform() === 'win32'
        ? ['cmd', ['/c', 'start', '', url]]
        : ['xdg-open', [url]];
  try {
    const child = spawn(command, args, { stdio: 'ignore', detached: true });
    child.on('error', () => {});
    child.unref();
  } catch {
    // The URL was printed; that is the fallback.
  }
}
