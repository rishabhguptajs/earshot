import { createHash, randomBytes } from 'node:crypto';

export interface PkcePair {
  verifier: string;
  challenge: string;
  method: 'S256';
}

/**
 * A PKCE verifier and its S256 challenge.
 *
 * The verifier never leaves this process until the code exchange, which is the
 * point of PKCE: the authorisation code that arrives on a loopback redirect is
 * useless to anything that did not generate the verifier, so another program
 * watching the callback cannot spend it.
 */
export function createPkcePair(): PkcePair {
  // 32 bytes of randomness, base64url'd to 43 characters - the shortest length
  // RFC 7636 allows, and the length every provider tested accepts.
  const verifier = base64url(randomBytes(32));
  const challenge = base64url(createHash('sha256').update(verifier).digest());
  return { verifier, challenge, method: 'S256' };
}

export function base64url(buffer: Buffer): string {
  return buffer.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
