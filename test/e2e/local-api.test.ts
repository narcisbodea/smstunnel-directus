/**
 * The shared client against a real (local) SMSTunnel API: send, status, phones, usage, an idempotent retry and a
 * refused key. Skipped unless SMSTUNNEL_E2E_KEY_FILE is set (see e2e-env.ts); never runs against smstunnel.io.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { SmsTunnelClient, SmsTunnelError } from '../../src/smstunnel/client';
import { fetchTransport } from '../../src/smstunnel/fetch-transport';
import { eventually, loadE2eEnv, storedTexts, testNumber } from './e2e-env';

const env = loadE2eEnv();

describe('the client against the local SMSTunnel API', { skip: env ? false : 'SMSTUNNEL_E2E_KEY_FILE is not set' }, () => {
  const client = () => new SmsTunnelClient({ apiKey: env!.apiKey, baseUrl: env!.serverUrl, transport: fetchTransport() });

  it('lists the phones: the test phone is online', async () => {
    const phones = await client().listPhones();
    assert.ok(phones.devices.some((d) => d.id === env!.deviceId && d.isOnline), 'the test phone should be online');
    assert.ok(phones.online >= 1);
  });

  it('sends a text, the server stores it, and its status is readable', async () => {
    const since = new Date(Date.now() - 1000);
    const to = testNumber();
    const message = `SMSTunnel plugin e2e ${Date.now()}`;
    const sent = await client().sendText({ to, message, deviceId: env!.deviceId });
    assert.match(sent.messageId, /^[a-f0-9]{24}$/);
    assert.equal(sent.queued, false);

    const status = await eventually(async () => {
      const s = await client().getStatus(sent.messageId);
      return s.status === 'sent' || s.status === 'delivered' ? s : undefined;
    }, 30_000, 'the phone to send it');
    assert.equal(status.id, sent.messageId);

    const stored = await storedTexts(to, since);
    if (stored) {
      assert.equal(stored.length, 1);
      assert.equal(stored[0].id, sent.messageId);
      assert.equal(stored[0].message, message);
    }
  });

  it('a retry with the same idempotency key gets the first answer, and only one text', async () => {
    const since = new Date(Date.now() - 1000);
    const to = testNumber();
    const key = `plugin-e2e-${Date.now()}`;
    const input = { to, message: `Idempotent e2e ${key}`, idempotencyKey: key };
    const first = await client().sendText(input);
    const second = await client().sendText(input);
    assert.equal(second.messageId, first.messageId);
    assert.equal(first.replayed, false);
    assert.equal(second.replayed, true);
    const stored = await storedTexts(to, since);
    if (stored) assert.equal(stored.length, 1);

    // The same key for another text is refused.
    await assert.rejects(client().sendText({ ...input, message: 'something else' }), (error: SmsTunnelError) => {
      assert.equal(error.status, 422);
      assert.equal(error.code, 'IDEMPOTENCY_KEY_REUSED');
      return true;
    });
  });

  it('sends a sign-in code, and refuses a code text without a code', async () => {
    const sent = await client().sendCode({ to: testNumber(), message: 'Your sign-in code is 482913' });
    assert.match(sent.messageId, /^[a-f0-9]{24}$/);
    await assert.rejects(client().sendCode({ to: testNumber(), message: 'No code here' }), (error: SmsTunnelError) => {
      assert.equal(error.status, 400);
      assert.match(error.message, /code/i);
      return true;
    });
  });

  it('reads the usage', async () => {
    const usage = await client().getUsage();
    assert.equal(typeof usage.plan, 'string');
  });

  it('a wrong key is refused with 401 and the dashboard link', async () => {
    const bad = new SmsTunnelClient({ apiKey: 'sk_' + 'live_not_a_real_key_000000000000000', baseUrl: env!.serverUrl, transport: fetchTransport() });
    await assert.rejects(bad.listPhones(), (error: SmsTunnelError) => {
      assert.equal(error.status, 401);
      assert.match(error.message, /dashboard\.smstunnel\.io\/apps/);
      return true;
    });
  });
});
