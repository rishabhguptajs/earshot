interface Env {
  DB: D1Database;
}

const EVENTS = new Set([
  'telemetry_enabled',
  'telemetry_disabled',
  'session_started',
  'session_completed',
  'session_failed',
  'tool_used',
]);
const OS = new Set(['darwin', 'linux', 'win32', 'other']);
const ARCH = new Set(['arm64', 'x64', 'other']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SAFE = /^[a-z0-9._-]{1,80}$/i;

function valid(body: unknown): body is Record<string, string> {
  if (!body || typeof body !== 'object') return false;
  const value = body as Record<string, unknown>;
  return (
    typeof value.installation_id === 'string' &&
    UUID.test(value.installation_id) &&
    typeof value.event === 'string' &&
    EVENTS.has(value.event) &&
    typeof value.timestamp === 'string' &&
    value.timestamp.length <= 40 &&
    typeof value.version === 'string' &&
    SAFE.test(value.version) &&
    typeof value.os === 'string' &&
    OS.has(value.os) &&
    typeof value.arch === 'string' &&
    ARCH.has(value.arch) &&
    (value.tool === undefined || (typeof value.tool === 'string' && SAFE.test(value.tool))) &&
    (value.provider === undefined ||
      (typeof value.provider === 'string' && /^[a-z0-9-]{1,40}$/i.test(value.provider)))
  );
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method !== 'POST' || url.pathname !== '/v1/events')
      return new Response('not found', { status: 404 });
    if (Number(request.headers.get('content-length') ?? 0) > 2048)
      return new Response('payload too large', { status: 413 });
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return new Response('invalid payload', { status: 400 });
    }
    if (!valid(body)) return new Response('invalid payload', { status: 400 });
    const value = body;
    await env.DB.prepare(
      'INSERT INTO telemetry_events (installation_id,event,timestamp,version,os,arch,tool,provider) VALUES (?,?,?,?,?,?,?,?)',
    )
      .bind(
        value.installation_id,
        value.event,
        value.timestamp,
        value.version,
        value.os,
        value.arch,
        value.tool ?? null,
        value.provider ?? null,
      )
      .run();
    return new Response(null, { status: 204 });
  },
};
