/**
 * "Send a text with SMSTunnel": what the operation does, apart from Directus. One run sends one text, to one
 * number, from your own phone. api.ts runs it in Directus' sandbox; the tests run it with a fake transport.
 */
import { DEFAULT_BASE_URL, SmsTunnelClient, SmsTunnelError, type Transport } from './smstunnel/client';

export const OPERATION_ID = 'smstunnel-send-text';
export const VERSION = '1.0.0';

/** The operation's options, after Directus filled in `{{ … }}` from the flow. */
export interface SendTextOptions {
  /** Your SMSTunnel API key. Best: `{{ $env.SMSTUNNEL_API_KEY }}` with FLOWS_ENV_ALLOW_LIST=SMSTUNNEL_API_KEY. */
  apiKey?: unknown;
  /** One number, in international format: `+14155550123`, or `{{ $trigger.payload.phone }}`. */
  to?: unknown;
  message?: unknown;
  /** `text` (default) or `code` (a sign-in code, through /sms/send-2fa). */
  kind?: unknown;
  /** The phone that sends (its ID is under Phones in the dashboard). Empty: your phone that is online. */
  deviceId?: unknown;
  /** Completes numbers written without + or 00, such as +40. */
  defaultCountryCode?: unknown;
  /** A retry with the same key within 24 hours gets the first answer instead of a second text. */
  idempotencyKey?: unknown;
  /** Not in the panel: another SMSTunnel address. The sandbox lets the extension call only https://smstunnel.io. */
  apiBase?: unknown;
}

/** What the next operations see as `$last` (or under the operation's key). */
export interface SendTextResult {
  messageId: string;
  to: string;
  /** `queued`: your phone is offline; the text goes out when it is back online. `pending`: handed to your phone. */
  status: 'queued' | 'pending';
  queued: boolean;
  /** `true` when an earlier run with the same idempotency key had already sent it (nothing new was sent). */
  replayed: boolean;
}

/** What the reject path gets as `$last` when the text didn't go out. */
export interface SendTextFailure {
  message: string;
  status?: number;
  code?: string;
  permission?: string;
  retryAfter?: number;
  /** The text may have gone out although the call failed (timeout, 5xx). Check before sending it again. */
  mayHaveSent: boolean;
}

/**
 * Directus fills a `{{ … }}` that finds nothing with the text "undefined" (or "null"): for an optional field
 * that means "not set".
 */
const UNSET = new Set(['undefined', 'null']);

const text = (value: unknown): string | undefined => {
  if (typeof value === 'number') return String(value);
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed === '' || UNSET.has(trimmed) ? undefined : trimmed;
};

/** `to` and `message` as the client should see them: a `{{ … }}` that found nothing becomes missing. */
const given = (value: unknown): unknown => (typeof value === 'string' && UNSET.has(value.trim()) ? undefined : value);

function keyProblem(apiKey: unknown): string | undefined {
  const key = typeof apiKey === 'string' ? apiKey.trim() : '';
  if (key === '' || key.includes('{{')) {
    return (
      'The SMSTunnel API key is missing. Set SMSTUNNEL_API_KEY in Directus\' environment, add it to FLOWS_ENV_ALLOW_LIST ' +
      '(FLOWS_ENV_ALLOW_LIST=SMSTUNNEL_API_KEY) and restart, then keep "{{ $env.SMSTUNNEL_API_KEY }}" in the API key field. ' +
      'Create a key at https://dashboard.smstunnel.io/apps → Add an app.'
    );
  }
  return undefined;
}

function failureOf(error: unknown, baseUrl: string): SendTextFailure {
  if (error instanceof SmsTunnelError) {
    const failure: SendTextFailure = { message: error.message, mayHaveSent: error.mayHaveSent };
    if (error.status !== undefined) failure.status = error.status;
    if (error.code !== undefined) failure.code = error.code;
    if (error.permission !== undefined) failure.permission = error.permission;
    if (error.retryAfter !== undefined) failure.retryAfter = error.retryAfter;
    if (error.kind === 'network' && /No permission to request/.test(error.message)) {
      failure.message = `Directus' sandbox doesn't let this extension call ${baseUrl}: it may only call ${DEFAULT_BASE_URL}.`;
    }
    return failure;
  }
  return { message: error instanceof Error ? error.message : String(error), mayHaveSent: false };
}

/**
 * Sends the text. On failure it throws a JSON string (like Directus' own Webhook / Request URL operation), so the
 * reject path gets an object: `{ message, status?, code?, retryAfter?, mayHaveSent }`.
 */
export async function sendText(options: SendTextOptions, transport: Transport): Promise<SendTextResult> {
  const baseUrl = text(options?.apiBase) ?? DEFAULT_BASE_URL;
  try {
    if (Array.isArray(options?.to)) {
      throw new SmsTunnelError(
        'One number per text. To text several people, give the list to a "Trigger Flow" operation and put this operation in that flow: it runs once per number.',
        { kind: 'input' },
      );
    }
    const problem = keyProblem(options?.apiKey);
    if (problem) throw new SmsTunnelError(problem, { kind: 'input' });

    const client = new SmsTunnelClient({
      apiKey: String(options.apiKey),
      baseUrl,
      deviceId: text(options.deviceId),
      defaultCountryCode: text(options.defaultCountryCode),
      userAgent: `smstunnel-directus/${VERSION}`,
      transport,
    });
    const input = {
      to: given(options.to) as string,
      message: given(options.message) as string,
      idempotencyKey: text(options.idempotencyKey),
    };
    const sent = text(options.kind) === 'code' ? await client.sendCode(input) : await client.sendText(input);
    return {
      messageId: sent.messageId,
      to: String(options.to).trim(),
      status: sent.queued ? 'queued' : 'pending',
      queued: sent.queued,
      replayed: sent.replayed,
    };
  } catch (error) {
    throw JSON.stringify(failureOf(error, baseUrl));
  }
}
