/**
 * The HTTP call for Node.js 18+ and other runtimes with a global `fetch`. Same file in each SMSTunnel plugin.
 */
import { TransportError, type Transport } from './client';

type FetchLike = (url: string, init: Record<string, unknown>) => Promise<{
  status: number;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
}>;

/** Errors raised before the request left this machine: SMSTunnel never saw it. */
const NEVER_ARRIVED = new Set([
  'ECONNREFUSED',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'EADDRNOTAVAIL',
  'UND_ERR_CONNECT_TIMEOUT',
  'CERT_HAS_EXPIRED',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'ERR_TLS_CERT_ALTNAME_INVALID',
]);

function systemCodeOf(error: unknown): string | undefined {
  let current: any = error;
  for (let depth = 0; current && depth < 4; depth++) {
    if (typeof current.code === 'string') return current.code;
    current = current.cause;
  }
  return undefined;
}

/** A transport over `fetch` (the global one unless you pass another, for tests or a proxy). */
export function fetchTransport(fetchImpl?: FetchLike): Transport {
  return async (request) => {
    const doFetch: FetchLike = fetchImpl ?? ((url, init) => (globalThis as any).fetch(url, init));
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), request.timeoutMs);
    try {
      const res = await doFetch(request.url, {
        method: request.method,
        headers: request.headers,
        ...(request.body !== undefined ? { body: request.body } : {}),
        signal: controller.signal,
        redirect: 'manual',
      });
      const text = await res.text();
      return {
        status: res.status,
        headers: {
          'retry-after': res.headers.get('retry-after') ?? undefined,
          'idempotent-replayed': res.headers.get('idempotent-replayed') ?? undefined,
        },
        body: text,
      };
    } catch (error) {
      if (controller.signal.aborted) throw new TransportError('No answer in time', 'timeout', true);
      const code = systemCodeOf(error);
      throw new TransportError(
        (error as Error)?.message ?? 'Network error',
        'network',
        !(code && NEVER_ARRIVED.has(code)),
        code,
      );
    } finally {
      clearTimeout(timer);
    }
  };
}
