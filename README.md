# SMSTunnel for Directus

`@narcisbodea/smstunnel-directus`: a **Send a text with SMSTunnel** operation for Directus Flows. Each run sends one text from **your own Android phone**, from **your own number**, through [SMSTunnel](https://smstunnel.io).

A flow hands the text to your SMSTunnel account, and your phone sends it from its own SIM, so people see a number they know and can reply to. No SMS provider account and no sender registration: the phone runs the SMSTunnel app and is linked to your account.

<a href="https://play.google.com/store/apps/details?id=io.smstunnel.app"><img src="https://smstunnel.io/google-play-badge.png" alt="Get it on Google Play" height="56"></a>

SMSTunnel for Directus is made by NARBOWEB SRL. It is not affiliated with, endorsed by, or sponsored by Monospace Inc. or the Directus project.

## Install

**From the Marketplace** (Directus 11 and 12): **Settings → Marketplace**, search for **SMSTunnel**, open it and click **Install**. The operation runs in Directus' extension sandbox, so the Marketplace installs it with its default trust setting (`MARKETPLACE_TRUST=sandbox`). The sandbox lets it call only `https://smstunnel.io/api/v1/*`.

**By hand** (self-hosted): put the package in your extensions folder and restart Directus:

```bash
cd extensions
npm pack @narcisbodea/smstunnel-directus
mkdir smstunnel-directus && tar -xzf narcisbodea-smstunnel-directus-*.tgz -C smstunnel-directus --strip-components=1
```

Tested with Directus 12.6.0 and 11.17.4.

## Get your key

1. Install the [SMSTunnel app from Google Play](https://play.google.com/store/apps/details?id=io.smstunnel.app) on the Android phone that will send the texts, and sign in.
2. Open your dashboard at [dashboard.smstunnel.io/apps](https://dashboard.smstunnel.io/apps). The phone shows up under **Phones** (or link it there with **Phones → Add phone**).
3. Under **Apps**, click **Add an app** and copy the key it shows. A new key can send texts and look up their status.

Then give it to Directus as an environment variable, and let flows read it:

```bash
SMSTUNNEL_API_KEY=sk_live_...
FLOWS_ENV_ALLOW_LIST=SMSTUNNEL_API_KEY
```

Restart Directus. The operation's **API key** field is already `{{ $env.SMSTUNNEL_API_KEY }}`: the key stays out of your flows, and Directus shows it as `--redacted:SMSTUNNEL_API_KEY--` in the flow logs. (Pasting the key into the field works too, but then it is stored with the flow and appears in its logs; keep that for a quick test.)

## Text each new item

For example a `leads` collection with `name` and `phone` fields:

1. **Settings → Flows → Create Flow**. Name it, choose the trigger **Event Hook**, type **Action (Non-Blocking)**, scope `items.create`, collection **leads**.
2. Click **+** after the trigger and choose **Send a text with SMSTunnel**:
   - **To**: `{{ $trigger.payload.phone }}`
   - **Message**: `Thanks {{ $trigger.payload.name }}, we got your request and will call you back today.`
   - **Idempotency key**: `lead-{{ $trigger.key }}`
3. Save, then add a lead with your own number.

The same operation fits after a **Webhook**, a **Schedule (CRON)**, a **Manual** trigger or another operation: every field takes `{{ … }}`.

| Field | |
| --- | --- |
| **API key** | `{{ $env.SMSTUNNEL_API_KEY }}` (see above). |
| **To** | One number, in international format (`+14155550123`). |
| **Type** | **Text**, or **Sign-in code**: the text must then contain the code, 4 to 10 digits on their own (`482913`, or `123-456`), 320 characters at most, and it counts against your sign-in code allowance. |
| **Message** | Up to 1600 characters. |
| **Phone ID** | Optional: the phone that sends, when your account has several (its ID is under **Phones**, with a Copy button). Empty: your phone that is online. |
| **Country code** | Optional, e.g. `+40`: completes numbers written without `+` or `00`. |
| **Idempotency key** | Optional: one key per text. Running it again with the same key within 24 hours sends nothing new (the run reports `replayed: true`). Make it unique for good: a key used for another text in the last 24 hours is refused. |

A `{{ … }}` that finds nothing (Directus then writes `undefined`) counts as empty for the optional fields, and as missing for **To** and **Message**.

## What the next operations get

When the text is handed over, the operation resolves with:

```json
{ "messageId": "6ae9952f7f9ac207c547af90", "to": "+14155550123", "status": "pending", "queued": false, "replayed": false }
```

`status` is `queued` when your phone is offline: the text waits in the queue on your account and goes out as soon as the phone is back online (up to 3 days). Read it later as `{{ $last.messageId }}` or `{{ <operation key>.messageId }}`.

When it isn't, the flow takes the operation's **reject** path, with:

```json
{ "message": "SMSTunnel refused the API key: …", "status": 401, "mayHaveSent": false }
```

| `status` | What it means |
| --- | --- |
| 401 | The API key is wrong, deactivated or deleted. Create a new one under **Apps → Add an app**. |
| 403 | The key lacks a permission, or your plan doesn't include what was asked. |
| 429 | Too many requests (30 sends a minute per key), or today's allowance of your plan is used up ([pricing](https://smstunnel.io/pricing/)). |
| 5xx, or none | SMSTunnel had a problem or didn't answer. `mayHaveSent` is `true`: check the Messages page in your dashboard before you send it again, or run it again with the same idempotency key. |
| 400 | SMSTunnel refused a field, such as a number it can't read or a code text without a code. |
| 404 | The phone ID isn't one of your phones. |
| 422 | The idempotency key was already used for a different text in the last 24 hours. |

A number that isn't one, a list of numbers, an empty text or one over 1600 characters is refused before anything is sent (no `status`). Inside Directus' sandbox only SMSTunnel's status code reaches the extension, so the reasons above are worded from the status.

The operation never resends a text by itself.

## Several people

One run sends one text. To text a list, put the operation in its own flow (trigger **Another Flow**, To `{{ $trigger.phone }}`), and call that flow from a **Trigger Flow** operation whose payload is the list, for example `{{ $last }}` from a **Read Data** operation. Directus runs the flow once per item; choose **Serial** as the iteration mode to keep within 30 texts a minute.

## Build it with an AI assistant

Paste this into Claude, ChatGPT, Cursor or Copilot and replace the part in brackets. Never paste your real API key into a prompt.

```text
Help me send texts from Directus with SMSTunnel. SMSTunnel sends each text from my own Android phone, from my own number: the phone runs the SMSTunnel app and is linked to my SMSTunnel account.

I installed the Directus extension @narcisbodea/smstunnel-directus (Marketplace: "SMSTunnel"). It adds the Flows operation "Send a text with SMSTunnel" (type id smstunnel-send-text) with the options: apiKey (keep "{{ $env.SMSTUNNEL_API_KEY }}"; Directus has SMSTUNNEL_API_KEY and FLOWS_ENV_ALLOW_LIST=SMSTUNNEL_API_KEY in its environment), to (one number in international format, e.g. "{{ $trigger.payload.phone }}"), kind ("text" or "code"; a code text must contain a code of 4 to 10 digits standing on its own, at most 320 characters), message (up to 1600 characters), deviceId (optional: which phone sends), defaultCountryCode (optional, e.g. "+40", completes numbers written without + or 00), idempotencyKey (optional, one per text: a re-run with the same key within 24 h sends nothing new). It resolves with { messageId, to, status: "pending" | "queued", queued, replayed } and rejects with { message, status, code?, retryAfter?, mayHaveSent }. One text per run: for a list, a Trigger Flow operation (iteration mode Serial) calls a flow that holds this operation once per item.

Behind it is the SMSTunnel API: POST https://smstunnel.io/api/v1/sms/send with the header X-API-Key and the JSON body {"to", "message", "deviceId"?, "defaultCountryCode"?}; one recipient per call; 30 send requests a minute per key. Errors: 401 wrong key, 403 missing permission or plan, 429 too many requests or today's allowance used up, 5xx SMSTunnel problem (the text may have gone out: never resend without the same idempotency key). If the phone is offline, the text waits in the queue (status "queued") and goes out when the phone is back online.

What I want: [describe what should send a text, to whom, and when]

Give me the flow step by step (trigger, its options, each operation and its options), plus the collection fields it needs.

Rules:
- Keep the key in Directus' environment through {{ $env.SMSTUNNEL_API_KEY }}, never pasted into a flow, a script operation or anything a browser can see.
- Store phone numbers as text in international format; skip the text (a Condition operation) when there is none.
- Handle the reject path: log it or notify an admin; don't loop back into the same operation.
- Only send texts people expect (confirmations, reminders, order updates, sign-in codes).
```

## Responsible use

Send only texts that people expect from you: confirmations, reminders, order updates, sign-in codes. Unsolicited messages from a personal SIM break most carriers' terms of service. Make sure your use follows your carrier's terms and local rules (in the EU, GDPR and the ePrivacy rules on electronic communications).

## Development

```bash
npm install
npm run typecheck
npm test            # unit tests: the operation with a fake sandbox request, the client with fetch replaced
npm run build       # directus-extension build → dist/api.js (sandboxed) and dist/app.js
```

The end-to-end tests run only against a local SMSTunnel API, never smstunnel.io. They read `{ "serverUrl", "dockerServerUrl", "deviceId", "apiKey" | "keys" }` from a JSON file and, with `SMSTUNNEL_E2E_MONGO_URL`, check each text in the test server's database:

```bash
export SMSTUNNEL_E2E_KEY_FILE=/path/to/test-key.json   # SMSTUNNEL_E2E_KEY_NAME picks keys.<name>
npm run test:local-api              # the client against the local API
npm run test:e2e                    # Docker: directus/directus:12.6.0 with the built extension, flows made through the REST API
DIRECTUS_VERSION=11.17.4 npm run test:e2e
```

In the copy the end-to-end test mounts, the sandbox may call only the local API (not even smstunnel.io). It uses the compose project `smst-r3-directus` and removes its container and volumes at the end (`--keep` leaves it running).

Links: [SMSTunnel docs](https://smstunnel.io/docs/) · [Dashboard: Apps](https://dashboard.smstunnel.io/apps) · [Directus Flows](https://directus.com/docs/guides/automate/flows)

## Issues

Report a bug or ask for a feature at <https://github.com/narcisbodea/smstunnel-directus/issues>. For your SMSTunnel account, see <https://smstunnel.io/docs/>.

## License

MIT, © NARBOWEB SRL. See [LICENSE](LICENSE).
