/** A stand-in for `globalThis.fetch` in unit tests: records each request and answers from a handler. */
export interface CapturedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: any;
  signal?: AbortSignal;
}

type Answer = Response | Error | { status?: number; json?: unknown; text?: string; headers?: Record<string, string> };

export interface FakeFetch {
  calls: CapturedRequest[];
  restore(): void;
}

export function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
}

export const SENT = { success: true, messageId: 'msg_1', data: { messageId: 'msg_1', branded: false, remaining: { clean: 9, total: 10 } } };

export function installFakeFetch(handler: (request: CapturedRequest) => Answer | Promise<Answer> = () => json(200, SENT)): FakeFetch {
  const original = globalThis.fetch;
  const calls: CapturedRequest[] = [];
  globalThis.fetch = (async (input: any, init: any = {}) => {
    const headers: Record<string, string> = {};
    for (const [name, value] of Object.entries((init.headers ?? {}) as Record<string, string>)) headers[name.toLowerCase()] = value;
    const request: CapturedRequest = {
      url: String(input),
      method: init.method ?? 'GET',
      headers,
      body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined,
      signal: init.signal,
    };
    calls.push(request);
    const answer = await handler(request);
    if (answer instanceof Error) throw answer;
    if (answer instanceof Response) return answer;
    const text = answer.text ?? (answer.json !== undefined ? JSON.stringify(answer.json) : '');
    return new Response(text, { status: answer.status ?? 200, headers: answer.headers ?? {} });
  }) as typeof fetch;
  return {
    calls,
    restore() {
      globalThis.fetch = original;
    },
  };
}

/** An error like the one undici throws for a refused connection. */
export function networkError(code: string): Error {
  return Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error(code), { code }) });
}
