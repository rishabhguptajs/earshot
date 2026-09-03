import type { EarshotError } from './types.ts';

export function earshotError(
  kind: EarshotError['kind'],
  message: string,
  opts: { retryable?: boolean; status?: number; cause?: unknown } = {},
): EarshotError {
  return {
    kind,
    message,
    retryable: opts.retryable ?? (kind === 'rate_limit' || kind === 'server' || kind === 'network'),
    ...(opts.status !== undefined ? { status: opts.status } : {}),
    ...(opts.cause !== undefined ? { cause: opts.cause } : {}),
  };
}

/** Map an HTTP status to our error taxonomy. Adapters refine `message`. */
export function errorFromStatus(status: number, message: string, cause?: unknown): EarshotError {
  const kind: EarshotError['kind'] =
    status === 401 || status === 403
      ? 'auth'
      : status === 429
        ? 'rate_limit'
        : status >= 500
          ? 'server'
          : 'invalid_request';
  return earshotError(kind, message, { status, ...(cause !== undefined ? { cause } : {}) });
}

export class AbortedError extends Error {
  constructor() {
    super('aborted');
    this.name = 'AbortedError';
  }
}
