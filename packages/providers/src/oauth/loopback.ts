import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface LoopbackResult {
  /** Where to send the browser back to. Only known once the port is bound. */
  redirectUri: string;
  /** Resolves with the query parameters of the first callback request. */
  code: Promise<URLSearchParams>;
  close(): void;
}

const PAGE = (message: string) =>
  `<!doctype html><meta charset="utf-8"><title>earshot</title>` +
  `<body style="font:16px system-ui;padding:3rem;max-width:32rem">` +
  `<h1 style="font-size:1.2rem">${message}</h1>` +
  `<p>You can close this tab and go back to your terminal.</p>`;

/**
 * A one-shot loopback listener for an OAuth redirect.
 *
 * Bound to 127.0.0.1 on a port the OS picks, and closed as soon as it has the
 * one request it exists for. Not localhost: on a machine where that resolves to
 * ::1 first the provider's redirect and this listener end up on different
 * addresses, and the flow hangs with no error anywhere.
 */
export async function listenForCallback(timeoutMs = 300_000): Promise<LoopbackResult> {
  let settle: (params: URLSearchParams) => void = () => {};
  let fail: (error: Error) => void = () => {};
  const code = new Promise<URLSearchParams>((resolve, reject) => {
    settle = resolve;
    fail = reject;
  });

  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    // Browsers ask for a favicon on the way past; answering it as the callback
    // would end the flow with no code in hand.
    if (url.pathname === '/favicon.ico') {
      response.writeHead(404).end();
      return;
    }
    const params = url.searchParams;
    const failed = params.get('error');
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(PAGE(failed ? `Sign-in failed: ${failed}` : 'Signed in to earshot.'));
    if (failed) fail(new Error(`the provider returned "${failed}"`));
    else settle(params);
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });

  const timer = setTimeout(() => {
    fail(new Error('timed out waiting for the browser to come back'));
    server.close();
  }, timeoutMs);
  timer.unref();

  const { port } = server.address() as AddressInfo;
  const close = () => {
    clearTimeout(timer);
    server.close();
  };
  void code.then(close, close);

  return { redirectUri: `http://127.0.0.1:${port}/callback`, code, close };
}
