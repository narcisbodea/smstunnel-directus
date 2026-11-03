/**
 * What the end-to-end tests need: a local SMSTunnel API and a throwaway key, never smstunnel.io.
 *
 * - SMSTUNNEL_E2E_KEY_FILE: JSON with `serverUrl`, `dockerServerUrl`, `deviceId` and the key (`apiKey`, or
 *   `keys[SMSTUNNEL_E2E_KEY_NAME]`).
 * - SMSTUNNEL_E2E_MONGO_URL (optional): the test server's database, to check what it stored (read only). The
 *   `mongodb` driver is loaded from SMSTUNNEL_E2E_MONGODB_FROM (a package.json path whose project has it).
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

export interface E2eEnv {
  serverUrl: string;
  dockerServerUrl: string;
  apiKey: string;
  deviceId: string;
}

export function loadE2eEnv(): E2eEnv | undefined {
  const file = process.env.SMSTUNNEL_E2E_KEY_FILE;
  if (!file) return undefined;
  const json = JSON.parse(readFileSync(file, 'utf8'));
  const name = process.env.SMSTUNNEL_E2E_KEY_NAME;
  const apiKey: string | undefined = name ? json.keys?.[name] : json.apiKey;
  if (!apiKey) throw new Error(`No key ${name ? `keys.${name}` : 'apiKey'} in ${file}`);
  const serverUrl = String(json.serverUrl ?? '').replace(/\/+$/, '');
  if (!/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(serverUrl)) {
    throw new Error(`The end-to-end tests run only against a local API, not ${serverUrl}`);
  }
  return {
    serverUrl,
    dockerServerUrl: String(json.dockerServerUrl ?? serverUrl.replace(/127\.0\.0\.1|localhost/, 'host.docker.internal')),
    apiKey,
    deviceId: String(json.deviceId ?? ''),
  };
}

/** A test recipient in the +1 415 555 xxxx range, different on every run. */
export function testNumber(): string {
  return `+1415555${String(Math.floor(Math.random() * 9000) + 1000)}`;
}

export interface StoredText {
  id: string;
  phoneNumber: string;
  message: string;
  status: string;
  deviceId?: string;
  createdAt: Date;
}

/** The texts the test server stored for this number since `since`, oldest first (empty without a database). */
export async function storedTexts(phoneNumber: string, since: Date): Promise<StoredText[] | undefined> {
  const url = process.env.SMSTUNNEL_E2E_MONGO_URL;
  if (!url) return undefined;
  const from = process.env.SMSTUNNEL_E2E_MONGODB_FROM ?? 'D:/ANDROID/SMSserver/package.json';
  const { MongoClient } = createRequire(from)('mongodb');
  const client = await MongoClient.connect(url, { serverSelectionTimeoutMS: 5000 });
  try {
    const docs = await client
      .db()
      .collection('messages')
      .find({ phoneNumber, createdAt: { $gte: since } })
      .sort({ createdAt: 1 })
      .toArray();
    return docs.map((d: any) => ({
      id: String(d._id),
      phoneNumber: d.phoneNumber,
      message: d.message,
      status: d.status,
      deviceId: d.deviceId ? String(d.deviceId) : undefined,
      createdAt: d.createdAt,
    }));
  } finally {
    await client.close();
  }
}

/** Waits until `check` returns something truthy, or fails after `timeoutMs`. */
export async function eventually<T>(check: () => Promise<T | undefined | null | false>, timeoutMs = 30_000, label = 'condition'): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: unknown;
  while (Date.now() < deadline) {
    try {
      const value = await check();
      if (value) return value;
    } catch (error) {
      last = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Timed out waiting for ${label}${last ? `: ${(last as Error).message}` : ''}`);
}
