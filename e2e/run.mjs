#!/usr/bin/env node
// End-to-end test in the official Directus image (DIRECTUS_VERSION, default 12.6.0), with the built extension.
//
// 1. npm run build, then copy dist/ and package.json to e2e/.work/extension. In that copy the sandbox may call ONLY
//    the local SMSTunnel API (not smstunnel.io), so no test can reach production.
// 2. Start Directus with SMSTUNNEL_API_KEY in its environment and FLOWS_ENV_ALLOW_LIST=SMSTUNNEL_API_KEY.
// 3. Through the REST API: a `leads` collection, a flow on items.create whose operation is "Send a text with
//    SMSTunnel" with to = {{ $trigger.payload.phone }}; a webhook flow for the other cases.
// 4. Check the texts on the local SMSTunnel API (its database), the flow's stored log (no key in it), then
//    docker compose down -v (unless --keep).
//
// Needs SMSTUNNEL_E2E_KEY_FILE (and SMSTUNNEL_E2E_KEY_NAME), optionally SMSTUNNEL_E2E_MONGO_URL: see test/e2e/e2e-env.ts.
import { execFileSync, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const work = join(here, '.work');
const project = 'smst-r3-directus';
const version = process.env.DIRECTUS_VERSION ?? '12.6.0';
const port = Number(process.env.DIRECTUS_PORT ?? 19320);
const base = `http://127.0.0.1:${port}`;
const keep = process.argv.includes('--keep');

function fail(message) {
  throw new Error(message);
}
function check(condition, message, detail) {
  if (!condition) fail(detail === undefined ? message : `${message}: ${JSON.stringify(detail)}`);
  console.log(`  ✓ ${message}`);
}
function step(message) {
  console.log(`\n▶ ${message}`);
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// A ref'd timer per request: Docker's port proxy can accept a connection before Directus listens.
async function fetchWithTimeout(url, init = {}, ms = 30_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

// ─── Environment ────────────────────────────────────────────────────────────
const keyFile = process.env.SMSTUNNEL_E2E_KEY_FILE ?? fail('Set SMSTUNNEL_E2E_KEY_FILE (see test/e2e/e2e-env.ts).');
const keys = JSON.parse(readFileSync(keyFile, 'utf8'));
const keyName = process.env.SMSTUNNEL_E2E_KEY_NAME;
const apiKey = keyName ? keys.keys?.[keyName] : keys.apiKey;
if (!apiKey) fail(`No key in ${keyFile}`);
if (!/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?\/?$/.test(keys.serverUrl)) fail('Only a local SMSTunnel API, never smstunnel.io.');
const dockerApi = (keys.dockerServerUrl ?? keys.serverUrl.replace(/127\.0\.0\.1|localhost/, 'host.docker.internal')).replace(/\/+$/, '');
const deviceId = keys.deviceId;

const composeEnv = { ...process.env, SMSTUNNEL_API_KEY: apiKey, DIRECTUS_VERSION: version, DIRECTUS_PORT: String(port) };
const compose = (...args) =>
  spawnSync('docker', ['compose', '-p', project, '-f', join(here, 'docker-compose.yml'), ...args], { stdio: 'inherit', env: composeEnv });

async function mongoTexts(phoneNumber, since) {
  const url = process.env.SMSTUNNEL_E2E_MONGO_URL;
  if (!url) return undefined;
  const { MongoClient } = createRequire(process.env.SMSTUNNEL_E2E_MONGODB_FROM ?? 'D:/ANDROID/SMSserver/package.json')('mongodb');
  const client = await MongoClient.connect(url, { serverSelectionTimeoutMS: 5000 });
  try {
    return await client.db().collection('messages').find({ phoneNumber, createdAt: { $gte: since } }).sort({ createdAt: 1 }).toArray();
  } finally {
    await client.close();
  }
}

let token;
async function http(method, path, { body, expect = [200, 204] } = {}) {
  const res = await fetchWithTimeout(base + path, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = text;
  }
  if (!expect.includes(res.status)) fail(`${method} ${path} → ${res.status}: ${text.slice(0, 500)}`);
  return json;
}

async function waitFor(label, probe, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const value = await probe();
      if (value) return value;
    } catch {
      // not yet
    }
    await sleep(1000);
  }
  fail(`Timed out waiting for ${label}`);
}

async function texts(phone, since, label) {
  return waitFor(label, async () => {
    const found = await mongoTexts(phone, since);
    return found?.length ? found : undefined;
  }, 30_000);
}

const number = () => `+1415555${String(Math.floor(Math.random() * 9000) + 1000)}`;

// ─── Run ────────────────────────────────────────────────────────────────────
const started = new Date(Date.now() - 2000);
const runId = Date.now().toString(36);
let ok = false;

try {
  step('Building the extension');
  execFileSync('npm', ['run', 'build'], { cwd: root, stdio: 'inherit', shell: process.platform === 'win32' });
  rmSync(work, { recursive: true, force: true });
  mkdirSync(join(work, 'extension'), { recursive: true });
  cpSync(join(root, 'dist'), join(work, 'extension', 'dist'), { recursive: true });
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  pkg['directus:extension'].sandbox.requestedScopes.request.urls = [`${dockerApi}/api/v1/*`];
  writeFileSync(join(work, 'extension', 'package.json'), JSON.stringify(pkg, null, 2));
  check(true, `the test copy may call only ${dockerApi}/api/v1/*`);

  step(`Starting Directus ${version} (compose project ${project}, ${base})`);
  compose('down', '-v', '--remove-orphans');
  if (compose('up', '-d').status !== 0) fail('docker compose up failed');
  await waitFor("Directus", async () => (await fetchWithTimeout(`${base}/server/ping`, {}, 5000)).ok, 5 * 60_000);

  const login = await http('POST', '/auth/login', { body: { email: 'admin@example.com', password: 'e2e-admin-password' } });
  token = login.data.access_token;
  check(Boolean(token), 'signed in as the admin');

  const extensions = (await http('GET', '/extensions')).data;
  const ours = extensions.find((e) => e.schema?.name === '@narcisbodea/smstunnel-directus' || e.name === '@narcisbodea/smstunnel-directus');
  check(Boolean(ours) && (ours.schema?.type ?? ours.type) === 'operation', 'Directus loaded the operation extension');
  check((ours.schema?.sandbox?.enabled ?? ours.sandbox?.enabled) === true, 'it runs in the sandbox');
  // The app entry imports each app extension as a chunk (Directus 12) or inlines it (older versions).
  const entry = await (await fetchWithTimeout(`${base}/extensions/sources/index.js`)).text();
  const chunk = /import\('\.\/([^']+\.js)'\)/.exec(entry)?.[1];
  const appSource = chunk ? await (await fetchWithTimeout(`${base}/extensions/sources/${chunk}`)).text() : entry;
  check(appSource.includes('Send a text with SMSTunnel'), 'the Flows editor gets "Send a text with SMSTunnel"');

  step('A flow that texts each new lead');
  await http('POST', '/collections', {
    body: {
      collection: 'leads',
      meta: { icon: 'person' },
      schema: {},
      fields: [
        { field: 'id', type: 'integer', meta: { hidden: true }, schema: { is_primary_key: true, has_auto_increment: true } },
        { field: 'name', type: 'string' },
        { field: 'phone', type: 'string' },
      ],
    },
  });
  const flow = (
    await http('POST', '/flows', {
      body: {
        name: 'Text new leads',
        icon: 'sms',
        status: 'active',
        trigger: 'event',
        accountability: 'all',
        options: { type: 'action', scope: ['items.create'], collections: ['leads'] },
      },
    })
  ).data;
  const operation = (
    await http('POST', '/operations', {
      body: {
        flow: flow.id,
        key: 'text_lead',
        name: 'Text the lead',
        type: 'smstunnel-send-text',
        position_x: 19,
        position_y: 1,
        options: {
          apiKey: '{{ $env.SMSTUNNEL_API_KEY }}',
          to: '{{ $trigger.payload.phone }}',
          message: 'Thanks {{ $trigger.payload.name }}, we got your request and will call you back today.',
          // Item ids restart at 1 in every fresh test database: the run id keeps the key new for SMSTunnel.
          idempotencyKey: `lead-{{ $trigger.key }}-${runId}`,
          apiBase: dockerApi,
        },
      },
    })
  ).data;
  await http('PATCH', `/flows/${flow.id}`, { body: { operation: operation.id } });

  const leadPhone = number();
  await http('POST', '/items/leads', { body: { name: 'Ana', phone: leadPhone } });
  if (process.env.SMSTUNNEL_E2E_MONGO_URL) {
    const found = await texts(leadPhone, started, 'the lead text');
    check(found.length === 1, 'exactly one text for the new lead');
    check(found[0].message === 'Thanks Ana, we got your request and will call you back today.', `the text is "${found[0].message}"`);
  }

  const run = await waitFor('the flow log', async () => {
    const activity = (await http('GET', `/activity?filter[collection][_eq]=directus_flows&filter[item][_eq]=${flow.id}&sort=-timestamp&limit=1&fields=id,revisions.data`)).data;
    return activity?.[0]?.revisions?.[0]?.data ? activity[0].revisions[0].data : undefined;
  }, 30_000);
  const stepLog = run.steps?.find((s) => s.operation === operation.id);
  const stepResult = run.data?.text_lead;
  check(stepLog?.status === 'resolve' && /^[a-f0-9]{24}$/.test(stepResult?.messageId ?? ''), `the step resolved with the message id (${stepResult?.messageId})`);
  check(stepLog.options.apiKey === '--redacted:SMSTUNNEL_API_KEY--', 'the log shows the key as --redacted:SMSTUNNEL_API_KEY--');
  check(!JSON.stringify(run).includes(apiKey), 'the stored flow log does not contain the API key anywhere');

  step('A webhook flow for the other cases');
  const hook = (
    await http('POST', '/flows', {
      body: {
        name: 'Text from a webhook',
        status: 'active',
        trigger: 'webhook',
        accountability: 'all',
        options: { method: 'POST', async: false, return: '$last' },
      },
    })
  ).data;
  const hookOperation = (
    await http('POST', '/operations', {
      body: {
        flow: hook.id,
        key: 'send',
        name: 'Send',
        type: 'smstunnel-send-text',
        position_x: 19,
        position_y: 1,
        options: {
          apiKey: '{{ $env.SMSTUNNEL_API_KEY }}',
          to: '{{ $trigger.body.to }}',
          message: '{{ $trigger.body.message }}',
          kind: '{{ $trigger.body.kind }}',
          deviceId: '{{ $trigger.body.deviceId }}',
          idempotencyKey: '{{ $trigger.body.key }}',
          apiBase: dockerApi,
        },
      },
    })
  ).data;
  await http('PATCH', `/flows/${hook.id}`, { body: { operation: hookOperation.id } });
  const trigger = (body) => http('POST', `/flows/trigger/${hook.id}`, { body });

  const codePhone = number();
  const code = await trigger({ to: codePhone, message: 'Your sign-in code is 482913', kind: 'code', deviceId });
  check(/^[a-f0-9]{24}$/.test(code.messageId ?? '') && code.status === 'pending', 'a sign-in code goes out (send-2fa)', code);
  if (process.env.SMSTUNNEL_E2E_MONGO_URL) {
    const [text] = await texts(codePhone, started, 'the code text');
    check(text.message === 'Your sign-in code is 482913' && String(text.deviceId) === deviceId, 'stored as written, from the chosen phone');
  }

  const key = `directus-e2e-${Date.now()}`;
  const keyPhone = number();
  const first = await trigger({ to: keyPhone, message: 'Only once', kind: 'text', key });
  const again = await trigger({ to: keyPhone, message: 'Only once', kind: 'text', key });
  if (!(first.messageId === again.messageId && again.replayed === true)) console.log('    first:', JSON.stringify(first), 'again:', JSON.stringify(again));
  check(first.messageId === again.messageId && first.replayed === false && again.replayed === true, 'the same idempotency key twice: one text, the second run replayed', { first, again });
  if (process.env.SMSTUNNEL_E2E_MONGO_URL) {
    await sleep(1000);
    check((await mongoTexts(keyPhone, started)).length === 1, 'the server stored it once');
  }

  const list = await trigger({ to: `${number()},${number()}`, message: 'x', kind: 'text' });
  check(/One number per text/.test(list.message ?? '') && list.mayHaveSent === false, 'a list of numbers takes the reject path with the reason');
  const noCode = await trigger({ to: number(), message: 'No code in here', kind: 'code' });
  check(noCode.status === 400 && /code/i.test(noCode.message ?? ''), `a code text without a code: 400 from SMSTunnel ("${noCode.message}")`);

  step('The sandbox keeps the extension to its allowed address');
  const blocked = (
    await http('POST', '/flows', {
      body: { name: 'Elsewhere', status: 'active', trigger: 'webhook', accountability: 'all', options: { method: 'POST', async: false, return: '$last' } },
    })
  ).data;
  const blockedOperation = (
    await http('POST', '/operations', {
      body: {
        flow: blocked.id,
        key: 'send',
        name: 'Send',
        type: 'smstunnel-send-text',
        position_x: 19,
        position_y: 1,
        options: { apiKey: '{{ $env.SMSTUNNEL_API_KEY }}', to: number(), message: 'x', apiBase: 'http://example.invalid' },
      },
    })
  ).data;
  await http('PATCH', `/flows/${blocked.id}`, { body: { operation: blockedOperation.id } });
  const elsewhere = await http('POST', `/flows/trigger/${blocked.id}`, { body: {} });
  check(/sandbox doesn't let this extension call http:\/\/example\.invalid/.test(elsewhere.message ?? ''), 'another address is refused by the sandbox, with the reason');

  ok = true;
  console.log(`\nDirectus ${version} end-to-end test passed.`);
} catch (error) {
  console.error(`\n✗ ${error.message}`);
  compose('logs', '--tail', '60', 'directus');
} finally {
  if (!keep) {
    step('Removing the containers, network and volumes');
    compose('down', '-v', '--remove-orphans');
  }
}
process.exit(ok ? 0 : 1);
