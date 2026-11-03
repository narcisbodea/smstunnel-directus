/** The operation with a fake sandbox `request` that behaves like Directus' own (axios: throws on non-2xx). */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { OPERATION_ID, VERSION, sendText, type SendTextOptions } from '../../src/operation';
import { sandboxTransport, type SandboxRequest } from '../../src/sandbox-transport';
import app from '../../src/app';

const KEY = 'sk_' + 'test_directus_unit_42';

interface Call {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: any;
}

/** Answers like Directus' sandbox request: 2xx → { status, headers, data }; else throws an AxiosError-like object. */
function fakeRequest(answer: (call: Call) => { status: number; data?: unknown; headers?: Record<string, string> } | Error) {
  const calls: Call[] = [];
  const request: SandboxRequest = async (url, options) => {
    const call: Call = { url, method: options.method, headers: options.headers, body: options.body ? JSON.parse(options.body) : undefined };
    calls.push(call);
    const res = answer(call);
    if (res instanceof Error) throw res;
    if (res.status >= 200 && res.status < 300) return { status: res.status, statusText: 'OK', headers: res.headers ?? {}, data: res.data };
    // What reaches the isolate: Directus' wrap() turns object properties of the error into JSON text.
    throw Object.assign(new Error(`Request failed with status code ${res.status}`), {
      name: 'AxiosError',
      code: res.status >= 500 ? 'ERR_BAD_RESPONSE' : 'ERR_BAD_REQUEST',
      response: JSON.stringify({ status: res.status, statusText: 'x', headers: res.headers ?? {}, data: res.data }),
    });
  };
  return { request, calls };
}

const OK = { status: 200, data: { success: true, messageId: '6aea0000000000000000beef', data: { messageId: '6aea0000000000000000beef', branded: false } } };

async function failure(promise: Promise<unknown>): Promise<Record<string, any>> {
  try {
    await promise;
  } catch (thrown) {
    assert.equal(typeof thrown, 'string', 'the operation throws a JSON string, like Directus\' Request URL operation');
    return JSON.parse(thrown as string);
  }
  assert.fail('expected the operation to fail');
}

const base: SendTextOptions = { apiKey: KEY, to: '+14155550123', message: 'Hello from a flow' };

describe('the operation', () => {
  it('sends one text with the key in X-API-Key and returns what the next operations need', async () => {
    const { request, calls } = fakeRequest(() => OK);
    const result = await sendText(base, sandboxTransport(request));
    assert.deepEqual(result, { messageId: '6aea0000000000000000beef', to: '+14155550123', status: 'pending', queued: false, replayed: false });
    assert.equal(calls[0].url, 'https://smstunnel.io/api/v1/sms/send');
    assert.equal(calls[0].method, 'POST');
    assert.equal(calls[0].headers?.['X-API-Key'], KEY);
    assert.equal(calls[0].headers?.['User-Agent'], `smstunnel-directus/${VERSION}`);
    assert.deepEqual(calls[0].body, { to: '+14155550123', message: 'Hello from a flow' });
  });

  it('passes the phone, country code and idempotency key; a sign-in code goes to send-2fa', async () => {
    const { request, calls } = fakeRequest(() => OK);
    await sendText(
      { ...base, to: '0712345678', message: 'Your code is 482913', kind: 'code', deviceId: 'p1', defaultCountryCode: '+40', idempotencyKey: 'flow-1' },
      sandboxTransport(request),
    );
    assert.equal(calls[0].url, 'https://smstunnel.io/api/v1/sms/send-2fa');
    assert.deepEqual(calls[0].body, { to: '0712345678', message: 'Your code is 482913', deviceId: 'p1', defaultCountryCode: '+40' });
    assert.equal(calls[0].headers?.['Idempotency-Key'], 'flow-1');
  });

  it('a {{ … }} that found nothing ("undefined", "null") counts as not set', async () => {
    const { request, calls } = fakeRequest(() => OK);
    await sendText(
      { ...base, kind: 'undefined', deviceId: 'undefined', defaultCountryCode: 'null', idempotencyKey: 'undefined' },
      sandboxTransport(request),
    );
    assert.equal(calls[0].url, 'https://smstunnel.io/api/v1/sms/send');
    assert.deepEqual(calls[0].body, { to: '+14155550123', message: 'Hello from a flow' });
    assert.equal(calls[0].headers?.['Idempotency-Key'], undefined);

    const error = await failure(sendText({ ...base, to: 'undefined' }, sandboxTransport(request)));
    assert.match(error.message, /phone number \(to\) is missing/);
    const empty = await failure(sendText({ ...base, message: 'null' }, sandboxTransport(request)));
    assert.match(empty.message, /text \(message\) is empty/);
    assert.equal(calls.length, 1);
  });

  it('only the status survives Directus\' sandbox: the message still says what it means', async () => {
    const { request } = fakeRequest(() => new Error('Request failed with status code 422'));
    const error = await failure(sendText({ ...base, idempotencyKey: 'used-before' }, sandboxTransport(request)));
    assert.equal(error.status, 422);
    assert.match(error.message, /already used in the last 24 hours/);
  });

  it('reports a queued text and a replay', async () => {
    const queued = fakeRequest(() => ({ status: 200, data: { success: true, messageId: 'q1', queued: true, data: { messageId: 'q1', queued: true } } }));
    assert.equal((await sendText(base, sandboxTransport(queued.request))).status, 'queued');
    const replay = fakeRequest(() => ({ ...OK, headers: { 'Idempotent-Replayed': 'true' } }));
    assert.equal((await sendText({ ...base, idempotencyKey: 'k' }, sandboxTransport(replay.request))).replayed, true);
  });

  it('a missing key, or the $env template left unfilled, says how to set FLOWS_ENV_ALLOW_LIST', async () => {
    for (const apiKey of [undefined, '', '{{ $env.SMSTUNNEL_API_KEY }}']) {
      const { request, calls } = fakeRequest(() => OK);
      const error = await failure(sendText({ ...base, apiKey }, sandboxTransport(request)));
      assert.match(error.message, /FLOWS_ENV_ALLOW_LIST=SMSTUNNEL_API_KEY/);
      assert.equal(error.mayHaveSent, false);
      assert.equal(calls.length, 0);
    }
  });

  it('a list of numbers is refused, with how to loop in Directus', async () => {
    const { request, calls } = fakeRequest(() => OK);
    const error = await failure(sendText({ ...base, to: ['+14155550123', '+14155550124'] }, sandboxTransport(request)));
    assert.match(error.message, /One number per text.*Trigger Flow/);
    const comma = await failure(sendText({ ...base, to: '+14155550123,+14155550124' }, sandboxTransport(request)));
    assert.match(comma.message, /One number per text/);
    assert.equal(calls.length, 0);
  });

  it('a number from a numeric field is refused: it has lost its +', async () => {
    const { request } = fakeRequest(() => OK);
    const error = await failure(sendText({ ...base, to: 14155550123 }, sandboxTransport(request)));
    assert.match(error.message, /must be text/);
  });

  it('SMSTunnel\'s error comes through Directus\' throwing request with status, code and Retry-After', async () => {
    const cases: [ReturnType<typeof fakeRequest>, (e: Record<string, any>) => void][] = [
      [
        fakeRequest(() => ({ status: 401, data: { statusCode: 401, message: 'Invalid or expired API key' } })),
        (e) => {
          assert.equal(e.status, 401);
          assert.match(e.message, /refused the API key/);
        },
      ],
      [
        fakeRequest(() => ({ status: 403, data: { statusCode: 403, code: 'PERMISSION_REQUIRED', permission: 'sms:send', message: 'x' } })),
        (e) => {
          assert.equal(e.code, 'PERMISSION_REQUIRED');
          assert.equal(e.permission, 'sms:send');
        },
      ],
      [
        fakeRequest(() => ({ status: 429, data: { statusCode: 429, message: 'ThrottlerException' }, headers: { 'Retry-After': '42' } })),
        (e) => {
          assert.equal(e.retryAfter, 42);
          assert.match(e.message, /Try again in 42 seconds/);
        },
      ],
      [
        fakeRequest(() => ({ status: 400, data: { statusCode: 400, message: 'No valid verification code found' } })),
        (e) => assert.match(e.message, /No valid verification code found/),
      ],
      [
        fakeRequest(() => ({ status: 503, data: 'Service Unavailable' })),
        (e) => {
          assert.equal(e.status, 503);
          assert.equal(e.mayHaveSent, true);
        },
      ],
    ];
    for (const [{ request }, verify] of cases) verify(await failure(sendText(base, sandboxTransport(request))));
  });

  it('without the response attached, the status code in the message is still used', async () => {
    const { request } = fakeRequest(() => new Error('Request failed with status code 401'));
    assert.equal((await failure(sendText(base, sandboxTransport(request)))).status, 401);
  });

  it('no answer: a refused connection never sent it; a timeout may have', async () => {
    const refused = fakeRequest(() => Object.assign(new Error('connect ECONNREFUSED 1.2.3.4:443'), { code: 'ECONNREFUSED' }));
    const r = await failure(sendText(base, sandboxTransport(refused.request)));
    assert.equal(r.mayHaveSent, false);
    const timeout = fakeRequest(() => Object.assign(new Error('timeout of 0ms exceeded'), { code: 'ECONNABORTED' }));
    const t = await failure(sendText(base, sandboxTransport(timeout.request)));
    assert.equal(t.mayHaveSent, true);
    assert.match(t.message, /did not answer/);
  });

  it('an address the sandbox doesn\'t allow is explained', async () => {
    const { request } = fakeRequest(() => new Error('No permission to request "http://example.test/api/v1/sms/send"'));
    const error = await failure(sendText({ ...base, apiBase: 'http://example.test' }, sandboxTransport(request)));
    assert.match(error.message, /sandbox doesn't let this extension call http:\/\/example\.test/);
    assert.equal(error.mayHaveSent, false);
  });
});

describe('the extension', () => {
  const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
  const manifest = pkg['directus:extension'];

  it('is a sandboxed operation that may only call smstunnel.io, as the Marketplace lists by default', () => {
    assert.ok(pkg.keywords.includes('directus-extension'));
    assert.equal(manifest.type, 'operation');
    assert.equal(manifest.sandbox.enabled, true);
    assert.deepEqual(manifest.sandbox.requestedScopes.request.urls, ['https://smstunnel.io/api/v1/*']);
    assert.deepEqual(manifest.sandbox.requestedScopes.request.methods, ['GET', 'POST']);
    assert.match(manifest.host, /\^11/);
  });

  it('the panel and the server use the same id; the key field defaults to the $env template', () => {
    assert.equal(app.id, OPERATION_ID);
    const fields = (app.options as any[]).map((o) => o.field);
    assert.deepEqual(fields, ['apiKey', 'to', 'kind', 'message', 'deviceId', 'defaultCountryCode', 'idempotencyKey']);
    const key = (app.options as any[])[0];
    assert.equal(key.schema.default_value, '{{ $env.SMSTUNNEL_API_KEY }}');
    assert.equal(key.meta.options.masked, true);
    assert.deepEqual((app.overview as any)({ to: '+1', kind: 'code' }, { flow: {} }), [
      { label: 'To', text: '+1' },
      { label: 'Type', text: 'Sign-in code' },
    ]);
  });

  it('VERSION matches package.json', () => {
    assert.equal(VERSION, pkg.version);
  });
});
