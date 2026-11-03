/** Tests of the shared SMSTunnel client (same file in each SMSTunnel plugin), with `fetch` replaced. */
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { inspect } from 'node:util';
import {
  SmsTunnelClient,
  SmsTunnelError,
  checkNumber,
  parseRetryAfter,
} from '../../src/smstunnel/client';
import { fetchTransport } from '../../src/smstunnel/fetch-transport';
import { installFakeFetch, json, networkError, SENT, type FakeFetch } from './fake-fetch';

const KEY = 'sk_' + 'test_unit_0123456789';
let fake: FakeFetch | undefined;
afterEach(() => fake?.restore());

function client(extra: Partial<ConstructorParameters<typeof SmsTunnelClient>[0]> = {}) {
  return new SmsTunnelClient({ apiKey: KEY, baseUrl: 'https://api.example.test/', transport: fetchTransport(), ...extra });
}

async function rejected(promise: Promise<unknown>): Promise<SmsTunnelError> {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof SmsTunnelError, `expected SmsTunnelError, got ${String(error)}`);
    return error;
  }
  assert.fail('expected the call to fail');
}

describe('sending', () => {
  it('posts one text with the key in X-API-Key and nothing else in the URL', async () => {
    fake = installFakeFetch();
    const sent = await client({ userAgent: 'test/1' }).sendText({ to: ' +14155550123 ', message: 'Hello' });
    assert.deepEqual(sent, { messageId: 'msg_1', queued: false, replayed: false, branded: false, remaining: { clean: 9, total: 10 } });
    const [call] = fake.calls;
    assert.equal(call.url, 'https://api.example.test/api/v1/sms/send');
    assert.equal(call.method, 'POST');
    assert.equal(call.headers['x-api-key'], KEY);
    assert.equal(call.headers['content-type'], 'application/json');
    assert.equal(call.headers['user-agent'], 'test/1');
    assert.equal(call.headers['idempotency-key'], undefined);
    assert.deepEqual(call.body, { to: '+14155550123', message: 'Hello' });
    assert.ok(!call.url.includes(KEY));
  });

  it('adds the default phone and country code, and a call can override them', async () => {
    fake = installFakeFetch();
    const c = client({ deviceId: 'phone-a', defaultCountryCode: '+40' });
    await c.sendText({ to: '0712345678', message: 'Hi' });
    await c.sendText({ to: '0712345678', message: 'Hi', deviceId: 'phone-b', defaultCountryCode: '49' });
    assert.deepEqual(fake.calls[0].body, { to: '0712345678', message: 'Hi', deviceId: 'phone-a', defaultCountryCode: '+40' });
    assert.deepEqual(fake.calls[1].body, { to: '0712345678', message: 'Hi', deviceId: 'phone-b', defaultCountryCode: '49' });
  });

  it('sends the idempotency key as a header and reports a replay', async () => {
    fake = installFakeFetch(() => json(200, SENT, { 'idempotent-replayed': 'true' }));
    const sent = await client().sendText({ to: '+14155550123', message: 'Hi', idempotencyKey: 'order-1-placed' });
    assert.equal(fake.calls[0].headers['idempotency-key'], 'order-1-placed');
    assert.equal(sent.replayed, true);
  });

  it('reports a text queued for an offline phone', async () => {
    fake = installFakeFetch(() => json(200, { success: true, messageId: 'm2', queued: true, data: { messageId: 'm2', queued: true } }));
    const sent = await client().sendText({ to: '+14155550123', message: 'Hi' });
    assert.equal(sent.queued, true);
    assert.equal(sent.messageId, 'm2');
  });

  it('sends sign-in codes through send-2fa', async () => {
    fake = installFakeFetch();
    await client().sendCode({ to: '+14155550123', message: 'Your code is 482913' });
    assert.equal(fake.calls[0].url, 'https://api.example.test/api/v1/sms/send-2fa');
  });

  it('refuses before calling: lists, numbers, bad numbers, empty and long texts, bad keys', async () => {
    fake = installFakeFetch();
    const c = client();
    for (const to of ['+14155550123,+14155550124', '+14155550123;+1', '+14155550123\n+14155550124']) {
      assert.match((await rejected(c.sendText({ to, message: 'x' }))).message, /One number per text/);
    }
    assert.match((await rejected(c.sendText({ to: ['+14155550123'] as any, message: 'x' }))).message, /One number per text/);
    assert.match((await rejected(c.sendText({ to: 14155550123 as any, message: 'x' }))).message, /must be text/);
    assert.match((await rejected(c.sendText({ to: 'call me', message: 'x' }))).message, /is not a phone number/);
    assert.match((await rejected(c.sendText({ to: '', message: 'x' }))).message, /missing/);
    assert.match((await rejected(c.sendText({ to: '+14155550123', message: '  ' }))).message, /empty/);
    assert.match((await rejected(c.sendText({ to: '+14155550123', message: 'a'.repeat(1601) }))).message, /at most 1600/);
    assert.match((await rejected(c.sendCode({ to: '+14155550123', message: '1234 ' + 'a'.repeat(320) }))).message, /at most 320/);
    assert.match((await rejected(c.sendText({ to: '+14155550123', message: 'x', idempotencyKey: 'ü' }))).message, /printable ASCII/);
    const error = await rejected(c.sendText({ to: '+1', message: 'x' }));
    assert.equal(error.kind, 'input');
    assert.equal(fake.calls.length, 0);
  });

  it('accepts exactly 1600 characters', async () => {
    fake = installFakeFetch();
    await client().sendText({ to: '+14155550123', message: 'a'.repeat(1600) });
    assert.equal(fake.calls.length, 1);
  });

  it('needs a key and an http(s) address', () => {
    assert.throws(() => new SmsTunnelClient({ apiKey: ' ', transport: fetchTransport() }), /API key is missing/);
    assert.throws(() => new SmsTunnelClient({ apiKey: KEY, baseUrl: 'ftp://x', transport: fetchTransport() }), /not an http/);
  });

  it('keeps the key out of JSON and inspect output', () => {
    const c = client();
    assert.ok(!JSON.stringify(c).includes(KEY));
    assert.ok(!inspect(c, { depth: 5, showHidden: true }).includes(KEY));
  });
});

describe('errors', () => {
  it('401: says the key is wrong and where to make one', async () => {
    fake = installFakeFetch(() => json(401, { message: 'Invalid or expired API key', error: 'Unauthorized', statusCode: 401 }));
    const error = await rejected(client().sendText({ to: '+14155550123', message: 'x' }));
    assert.equal(error.status, 401);
    assert.match(error.message, /refused the API key/);
    assert.match(error.message, /dashboard\.smstunnel\.io\/apps/);
    assert.equal(error.mayHaveSent, false);
  });

  it('403 PERMISSION_REQUIRED: names the permission', async () => {
    fake = installFakeFetch(() => json(403, { statusCode: 403, code: 'PERMISSION_REQUIRED', permission: 'sms:read', message: 'no' }));
    const error = await rejected(client().getStatus('m1'));
    assert.equal(error.code, 'PERMISSION_REQUIRED');
    assert.equal(error.permission, 'sms:read');
    assert.match(error.message, /lacks the "sms:read" permission/);
  });

  it('403 for the plan: passes SMSTunnel\'s words on', async () => {
    fake = installFakeFetch(() => json(403, { statusCode: 403, message: 'Maximum privacy needs Professional' }));
    assert.match((await rejected(client().sendText({ to: '+14155550123', message: 'x' }))).message, /Maximum privacy needs Professional/);
  });

  it('429 with Retry-After: says how long to wait', async () => {
    fake = installFakeFetch(() => json(429, { statusCode: 429, message: 'ThrottlerException: Too Many Requests' }, { 'retry-after': '17' }));
    const error = await rejected(client().sendText({ to: '+14155550123', message: 'x' }));
    assert.equal(error.retryAfter, 17);
    assert.match(error.message, /Try again in 17 seconds/);
    assert.match(error.message, /30 send requests a minute/);
    assert.equal(error.mayHaveSent, false);
  });

  it('429 without Retry-After: the allowance for today is used up', async () => {
    fake = installFakeFetch(() => json(429, { statusCode: 429, message: 'Daily limit of 25 texts reached on the Free plan.' }));
    const error = await rejected(client().sendText({ to: '+14155550123', message: 'x' }));
    assert.equal(error.retryAfter, undefined);
    assert.equal(error.message, 'Daily limit of 25 texts reached on the Free plan.');
  });

  it('5xx on a send: the text may have gone out', async () => {
    fake = installFakeFetch(() => json(503, { statusCode: 503, message: 'Service Unavailable' }));
    const error = await rejected(client().sendText({ to: '+14155550123', message: 'x' }));
    assert.equal(error.mayHaveSent, true);
    assert.match(error.message, /may or may not have been taken/);
  });

  it('5xx on a read: just try later', async () => {
    fake = installFakeFetch(() => json(500, { statusCode: 500, message: 'Internal server error' }));
    const error = await rejected(client().listPhones());
    assert.equal(error.mayHaveSent, false);
    assert.match(error.message, /Try again in a little while/);
  });

  it('400: joins the validation messages', async () => {
    fake = installFakeFetch(() => json(400, { statusCode: 400, message: ['to must be a string', 'message too long'] }));
    assert.match((await rejected(client().sendText({ to: '+14155550123', message: 'x' }))).message, /to must be a string; message too long/);
  });

  it('with no words from SMSTunnel (an empty body), the status still says what happened', async () => {
    const cases: [number, RegExp][] = [
      [400, /check the number and the text/],
      [403, /lacks a permission, or your plan/],
      [404, /phone ID isn't one of your phones/],
      [409, /still being processed/],
      [422, /already used in the last 24 hours/],
      [429, /Too many requests to SMSTunnel, or your plan's allowance/],
    ];
    for (const [status, message] of cases) {
      fake?.restore();
      fake = installFakeFetch(() => ({ status, text: '' }));
      const error = await rejected(client().sendText({ to: '+14155550123', message: 'x' }));
      assert.equal(error.status, status);
      assert.match(error.message, message);
    }
  });

  it('a refused connection never reached SMSTunnel; a reset one may have', async () => {
    fake = installFakeFetch(() => networkError('ECONNREFUSED'));
    const refused = await rejected(client().sendText({ to: '+14155550123', message: 'x' }));
    assert.equal(refused.kind, 'network');
    assert.equal(refused.mayHaveSent, false);
    assert.match(refused.message, /ECONNREFUSED/);
    fake.restore();
    fake = installFakeFetch(() => networkError('ECONNRESET'));
    const reset = await rejected(client().sendText({ to: '+14155550123', message: 'x' }));
    assert.equal(reset.mayHaveSent, true);
    assert.match(reset.message, /may have gone out/);
  });

  it('a timeout on a send may have gone out', async () => {
    fake = installFakeFetch(
      (request) =>
        new Promise((_resolve, reject) => {
          request.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
        }),
    );
    const error = await rejected(client({ timeoutMs: 20 }).sendText({ to: '+14155550123', message: 'x' }));
    assert.equal(error.kind, 'timeout');
    assert.equal(error.mayHaveSent, true);
    assert.match(error.message, /did not answer/);
  });

  it('an answer that is not JSON, or success:false, is an error', async () => {
    fake = installFakeFetch(() => ({ status: 200, text: '<html>proxy</html>' }));
    assert.equal((await rejected(client().listPhones())).kind, 'invalid-response');
    fake.restore();
    fake = installFakeFetch(() => json(200, { success: false, error: 'Device not found' }));
    assert.match((await rejected(client().sendText({ to: '+14155550123', message: 'x' }))).message, /Device not found/);
  });

  it('a redirect is not followed with the key', async () => {
    fake = installFakeFetch(() => ({ status: 301, text: '', headers: { location: 'https://elsewhere.test/' } }));
    const error = await rejected(client().listPhones());
    assert.equal(error.status, 301);
    assert.equal(fake.calls.length, 1);
  });

  it('parses Retry-After as seconds or a date', () => {
    assert.equal(parseRetryAfter('5'), 5);
    const now = Date.parse('Wed, 21 Oct 2026 07:28:00 GMT');
    assert.equal(parseRetryAfter('Wed, 21 Oct 2026 07:28:10 GMT', now), 10);
    assert.equal(parseRetryAfter('Wed, 21 Oct 2026 07:27:00 GMT', now), 1);
    assert.equal(parseRetryAfter('soon'), undefined);
    assert.equal(parseRetryAfter(undefined), undefined);
  });
});

describe('reading', () => {
  it('status, phones and usage', async () => {
    fake = installFakeFetch((request) => {
      if (request.url.includes('/sms/status/')) return json(200, { success: true, data: { id: 'a/b', status: 'sent', phoneNumber: '+14155550123' } });
      if (request.url.endsWith('/devices')) return json(200, { success: true, data: { devices: [{ id: 'p1', name: 'Phone', isOnline: true }], online: 1, total: 1 } });
      return json(200, { success: true, data: { plan: 'free', usage: {}, limits: {}, remaining: {} } });
    });
    const c = client();
    assert.equal((await c.getStatus('a/b')).status, 'sent');
    assert.equal(fake.calls[0].url, 'https://api.example.test/api/v1/sms/status/a%2Fb');
    assert.equal(fake.calls[0].method, 'GET');
    assert.equal(fake.calls[0].headers['content-type'], undefined);
    assert.deepEqual(await c.listPhones(), { devices: [{ id: 'p1', name: 'Phone', isOnline: true }], online: 1, total: 1 });
    assert.equal((await c.getUsage()).plan, 'free');
  });

  it('checkNumber keeps the number as written', () => {
    assert.equal(checkNumber(' +1 (415) 555-0123 '), '+1 (415) 555-0123');
  });
});
