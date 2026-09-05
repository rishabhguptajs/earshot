import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { listenForCallback } from '../src/oauth/loopback.ts';
import { authorizeUrl, exchangeCode, OAuthError } from '../src/oauth/openrouter.ts';
import { base64url, createPkcePair } from '../src/oauth/pkce.ts';

describe('PKCE', () => {
  test('produces a challenge that is the S256 hash of the verifier', () => {
    const pair = createPkcePair();
    const expected = base64url(createHash('sha256').update(pair.verifier).digest());

    expect(pair.method).toBe('S256');
    expect(pair.challenge).toBe(expected);
    // The verifier is the secret; a challenge that contained it would defeat it.
    expect(pair.challenge).not.toBe(pair.verifier);
  });

  test('is different every time', () => {
    expect(createPkcePair().verifier).not.toBe(createPkcePair().verifier);
  });

  test('is url-safe, so it survives a query string unescaped', () => {
    const pair = createPkcePair();
    expect(pair.verifier).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(pair.challenge).toMatch(/^[A-Za-z0-9_-]+$/);
  });
});

describe('the authorize URL', () => {
  test('carries the callback and the challenge, never the verifier', () => {
    const pair = createPkcePair();
    const url = new URL(authorizeUrl('http://127.0.0.1:1234/callback', pair));

    expect(url.origin).toBe('https://openrouter.ai');
    expect(url.searchParams.get('callback_url')).toBe('http://127.0.0.1:1234/callback');
    expect(url.searchParams.get('code_challenge')).toBe(pair.challenge);
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.toString()).not.toContain(pair.verifier);
  });
});

describe('exchanging the code', () => {
  test('sends the verifier and stores the key it gets back', async () => {
    const pair = createPkcePair();
    let sent: unknown;
    const fake: typeof fetch = async (_url, init) => {
      sent = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ key: 'sk-or-v1-abc' }), { status: 200 });
    };

    const credentials = await exchangeCode('the-code', pair, fake);
    expect(credentials).toEqual({ type: 'api-key', apiKey: 'sk-or-v1-abc' });
    expect(sent).toEqual({
      code: 'the-code',
      code_verifier: pair.verifier,
      code_challenge_method: 'S256',
    });
  });

  test('fails loudly when the provider refuses the code', async () => {
    const fake: typeof fetch = async () => new Response('{}', { status: 400 });
    expect(exchangeCode('bad', createPkcePair(), fake)).rejects.toThrow(OAuthError);
  });

  test('fails loudly when the response has no key rather than storing nothing', async () => {
    const fake: typeof fetch = async () => new Response('{}', { status: 200 });
    expect(exchangeCode('x', createPkcePair(), fake)).rejects.toThrow(/no key/);
  });

  test('reports a network failure as an OAuth failure, not a raw fetch error', async () => {
    const fake: typeof fetch = async () => {
      throw new Error('ECONNREFUSED');
    };
    expect(exchangeCode('x', createPkcePair(), fake)).rejects.toThrow(/could not reach/);
  });
});

describe('the loopback listener', () => {
  test('binds 127.0.0.1 and hands back the code the browser brought', async () => {
    const listener = await listenForCallback(5_000);
    try {
      expect(listener.redirectUri).toStartWith('http://127.0.0.1:');
      await fetch(`${listener.redirectUri}?code=abc123`);
      expect((await listener.code).get('code')).toBe('abc123');
    } finally {
      listener.close();
    }
  });

  test('does not mistake the browser’s favicon request for the callback', async () => {
    const listener = await listenForCallback(5_000);
    try {
      const base = new URL(listener.redirectUri).origin;
      const favicon = await fetch(`${base}/favicon.ico`);
      expect(favicon.status).toBe(404);

      await fetch(`${listener.redirectUri}?code=real`);
      expect((await listener.code).get('code')).toBe('real');
    } finally {
      listener.close();
    }
  });

  test('reports a provider that came back with an error', async () => {
    const listener = await listenForCallback(5_000);
    try {
      await fetch(`${listener.redirectUri}?error=access_denied`);
      expect(listener.code).rejects.toThrow(/access_denied/);
    } finally {
      listener.close();
    }
  });
});
