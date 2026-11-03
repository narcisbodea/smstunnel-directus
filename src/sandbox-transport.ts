/**
 * The HTTP call inside Directus' extension sandbox: `request` from `directus:api` (Directus' own axios, limited to
 * the URLs in package.json → directus:extension.sandbox.requestedScopes).
 *
 * That `request` throws on any answer that isn't 2xx; Directus passes the answer along as JSON text in
 * `error.response`, so it is read back here and SMSTunnel's error reaches the client as if nothing had thrown.
 */
import { TransportError, type Transport } from './smstunnel/client';

export type SandboxRequest = (
  url: string,
  options: { method?: 'GET' | 'POST'; body?: string; headers?: Record<string, string> },
) => Promise<{ status: number; statusText?: string; headers?: Record<string, unknown>; data: unknown }>;

function lowerCaseHeaders(headers: unknown): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  if (!headers || typeof headers !== 'object') return out;
  for (const [name, value] of Object.entries(headers as Record<string, unknown>)) {
    if (value === undefined || value === null) continue;
    out[name.toLowerCase()] = Array.isArray(value) ? String(value[0]) : String(value);
  }
  return out;
}

function parseJson(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

/** Errors raised before the request left Directus: SMSTunnel never saw it. */
const NEVER_ARRIVED = /ECONNREFUSED|ENOTFOUND|EAI_AGAIN|EHOSTUNREACH|ENETUNREACH|CERT_|SELF_SIGNED|No permission to|denied|blocked/i;

export function sandboxTransport(request: SandboxRequest): Transport {
  return async (req) => {
    try {
      const res = await request(req.url, { method: req.method, headers: req.headers, ...(req.body !== undefined ? { body: req.body } : {}) });
      return { status: res.status, headers: lowerCaseHeaders(res.headers), body: res.data };
    } catch (error) {
      const err = (error ?? {}) as { message?: unknown; response?: unknown; code?: unknown };
      const response = parseJson(err.response) as { status?: unknown; headers?: unknown; data?: unknown } | undefined;
      if (response && typeof response.status === 'number') {
        return { status: response.status, headers: lowerCaseHeaders(response.headers), body: response.data };
      }
      const message = typeof err.message === 'string' ? err.message : String(error);
      const status = /status code (\d{3})/.exec(message);
      if (status) return { status: Number(status[1]), headers: {}, body: undefined };
      const code = typeof err.code === 'string' ? err.code : undefined;
      const timedOut = /timeout|ETIMEDOUT|ECONNABORTED/i.test(`${code ?? ''} ${message}`);
      throw new TransportError(message, timedOut ? 'timeout' : 'network', timedOut || !NEVER_ARRIVED.test(`${code ?? ''} ${message}`), code);
    }
  };
}
