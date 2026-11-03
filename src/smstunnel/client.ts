/**
 * A small client for the SMSTunnel API (https://smstunnel.io/docs/): your own Android phone sends each text from
 * your own number. The same file is in each SMSTunnel plugin (Medusa, Strapi, Directus, Payload).
 *
 * Plain ECMAScript with the HTTP call passed in, so it also runs where there is no `fetch` (the Directus sandbox):
 * no Node built-ins, no `URL`, no timers here.
 */

export const DEFAULT_BASE_URL = 'https://smstunnel.io';
export const DASHBOARD_APPS_URL = 'https://dashboard.smstunnel.io/apps';
export const DEFAULT_TIMEOUT_MS = 30_000;
/** Longest text `POST /api/v1/sms/send` takes, in characters. */
export const MAX_TEXT_LENGTH = 1600;
/** Longest sign-in code text `POST /api/v1/sms/send-2fa` takes, in characters. */
export const MAX_CODE_TEXT_LENGTH = 320;
/** Longest Idempotency-Key SMSTunnel takes. */
export const MAX_IDEMPOTENCY_KEY_LENGTH = 255;

// ─── Transport ──────────────────────────────────────────────────────────────

export interface TransportRequest {
  method: 'GET' | 'POST';
  url: string;
  headers: Record<string, string>;
  /** JSON text, for a POST. */
  body?: string;
  timeoutMs: number;
}

export interface TransportResponse {
  status: number;
  /** Header names in lower case. */
  headers: Record<string, string | undefined>;
  /** The body as text, or already parsed when the transport parses JSON itself. */
  body: unknown;
}

/** Makes one HTTP request. Throws a {@link TransportError} when no answer came. */
export type Transport = (request: TransportRequest) => Promise<TransportResponse>;

/** No answer from SMSTunnel. */
export class TransportError extends Error {
  /** `timeout`: no answer in time. `network`: DNS, TLS, refused or broken connection. */
  readonly reason: 'timeout' | 'network';
  /** `false` when the request certainly never left (connection refused, unknown host, bad certificate). */
  readonly mayHaveArrived: boolean;
  /** The system's code, such as `ECONNREFUSED`, when there is one. */
  readonly systemCode?: string;

  constructor(message: string, reason: 'timeout' | 'network', mayHaveArrived: boolean, systemCode?: string) {
    super(message);
    this.name = 'TransportError';
    this.reason = reason;
    this.mayHaveArrived = mayHaveArrived;
    if (systemCode) this.systemCode = systemCode;
  }
}

// ─── Errors ─────────────────────────────────────────────────────────────────

export type SmsTunnelErrorKind =
  /** Refused here, before any call: a missing key, a number that isn't one, an empty text. */
  | 'input'
  /** SMSTunnel answered with an error status (see `status` and `code`). */
  | 'http'
  /** No answer in time. */
  | 'timeout'
  /** SMSTunnel could not be reached, or the connection broke. */
  | 'network'
  /** The answer was not SMSTunnel's JSON (a proxy page, a wrong address). */
  | 'invalid-response';

export interface SmsTunnelErrorInit {
  kind: SmsTunnelErrorKind;
  status?: number;
  code?: string;
  permission?: string;
  retryAfter?: number;
  body?: unknown;
  mayHaveSent?: boolean;
}

/**
 * Why a call didn't go through.
 *
 * - `status`: SMSTunnel's HTTP status (401 bad key, 403 permission or plan, 429 too many, 5xx SMSTunnel problem);
 *   missing when there was no answer.
 * - `code`: SMSTunnel's own code when it sent one (`PERMISSION_REQUIRED`, `IDEMPOTENCY_KEY_REUSED`…).
 * - `retryAfter`: seconds to wait, from a 429's `Retry-After`. A 429 without it means the plan's allowance for
 *   today (or this month) is used up.
 * - `mayHaveSent`: for a send, SMSTunnel may have taken the text although this call failed (a timeout, a broken
 *   connection, a 5xx). Check the Messages page in the dashboard before sending it again, or send it again with
 *   the same idempotency key, which can't send it twice.
 */
export class SmsTunnelError extends Error {
  readonly kind: SmsTunnelErrorKind;
  readonly status?: number;
  readonly code?: string;
  readonly permission?: string;
  readonly retryAfter?: number;
  readonly body?: unknown;
  readonly mayHaveSent: boolean;

  constructor(message: string, init: SmsTunnelErrorInit) {
    super(message);
    this.name = 'SmsTunnelError';
    this.kind = init.kind;
    if (init.status !== undefined) this.status = init.status;
    if (init.code !== undefined) this.code = init.code;
    if (init.permission !== undefined) this.permission = init.permission;
    if (init.retryAfter !== undefined) this.retryAfter = init.retryAfter;
    if (init.body !== undefined) this.body = init.body;
    this.mayHaveSent = init.mayHaveSent === true;
  }
}

function inputError(message: string): SmsTunnelError {
  return new SmsTunnelError(message, { kind: 'input' });
}

/** The words of an error body: `message` may be a list (validation errors). */
export function errorMessageOf(body: unknown, status: number): string {
  if (body && typeof body === 'object') {
    const fields = body as Record<string, unknown>;
    if (Array.isArray(fields.message)) {
      const parts = fields.message.filter((m) => typeof m === 'string' && m.trim() !== '') as string[];
      if (parts.length > 0) return parts.join('; ');
    }
    if (typeof fields.message === 'string' && fields.message.trim() !== '') return fields.message.trim();
    if (typeof fields.error === 'string' && fields.error.trim() !== '') return fields.error.trim();
  }
  if (typeof body === 'string') {
    const text = body.trim();
    if (text !== '' && text.length <= 300 && !text.startsWith('<')) return text;
  }
  return `HTTP ${status}`;
}

/** Retry-After in seconds (a number of seconds or an HTTP date), or undefined. */
export function parseRetryAfter(value: string | undefined, now: number = Date.now()): number | undefined {
  if (value === undefined) return undefined;
  const raw = value.trim();
  if (raw === '') return undefined;
  if (/^\d+$/.test(raw)) return Number(raw);
  const date = Date.parse(raw);
  if (Number.isNaN(date)) return undefined;
  return Math.max(1, Math.ceil((date - now) / 1000));
}

const CHECK_DASHBOARD =
  'Check the Messages page in your SMSTunnel dashboard before sending it again, or send it again with the same idempotency key.';

/** The error for an answer with an error status, worded for the person who reads the log. */
export function httpError(status: number, body: unknown, retryAfterHeader: string | undefined, isSend: boolean): SmsTunnelError {
  const fields = body && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
  const code = typeof fields.code === 'string' ? fields.code : undefined;
  const permission = typeof fields.permission === 'string' ? fields.permission : undefined;
  const retryAfter = status === 429 || status === 409 ? parseRetryAfter(retryAfterHeader) : undefined;
  const said = errorMessageOf(body, status);
  const init: SmsTunnelErrorInit = { kind: 'http', status, code, permission, retryAfter, body };
  // No words from SMSTunnel (an empty body, or a runtime that keeps only the status, like Directus' sandbox).
  const silent = said === `HTTP ${status}`;

  if (status === 401) {
    return new SmsTunnelError(
      `SMSTunnel refused the API key: it is wrong, deactivated or deleted. Create a key in your dashboard (${DASHBOARD_APPS_URL} → Add an app).`,
      init,
    );
  }
  if (status === 403) {
    if (code === 'PERMISSION_REQUIRED') {
      const hint =
        permission === 'sms:inbox'
          ? 'In your dashboard (Apps), allow "Can also read received texts" for this key.'
          : `Create a key under Apps → Add an app (${DASHBOARD_APPS_URL}).`;
      return new SmsTunnelError(`This API key lacks the "${permission ?? 'needed'}" permission. ${hint}`, init);
    }
    if (silent) {
      return new SmsTunnelError("SMSTunnel refused this (HTTP 403): the API key lacks a permission, or your plan doesn't include it.", init);
    }
    return new SmsTunnelError(`SMSTunnel refused this: ${said}`, init);
  }
  if (status === 429) {
    if (retryAfter !== undefined) {
      const seconds = Math.max(1, retryAfter);
      const limit = isSend ? ' (30 send requests a minute per API key)' : '';
      return new SmsTunnelError(
        `Too many requests to SMSTunnel${limit}. Try again in ${seconds} second${seconds === 1 ? '' : 's'}.`,
        init,
      );
    }
    if (silent) {
      return new SmsTunnelError(
        "Too many requests to SMSTunnel, or your plan's allowance for today is used up (HTTP 429). Try again later.",
        init,
      );
    }
    // No Retry-After: the plan's allowance for today (or this month) is used up, in SMSTunnel's words.
    return new SmsTunnelError(said, init);
  }
  if (silent && status === 400) {
    return new SmsTunnelError(
      'SMSTunnel refused the request (HTTP 400): check the number and the text. A sign-in code text needs a code of 4 to 10 digits on its own.',
      init,
    );
  }
  if (silent && status === 404) {
    return new SmsTunnelError("SMSTunnel answered HTTP 404: no such message, or the phone ID isn't one of your phones.", init);
  }
  if (silent && status === 409) {
    return new SmsTunnelError('A request with this idempotency key is still being processed (HTTP 409). Try again in a moment.', init);
  }
  if (silent && status === 422) {
    return new SmsTunnelError(
      'This idempotency key was already used in the last 24 hours for a different text (HTTP 422). Use a new key for a new text.',
      init,
    );
  }
  if (status >= 500) {
    if (isSend) {
      return new SmsTunnelError(`SMSTunnel had a problem (HTTP ${status}), so the text may or may not have been taken. ${CHECK_DASHBOARD}`, {
        ...init,
        mayHaveSent: true,
      });
    }
    return new SmsTunnelError(`SMSTunnel had a problem (HTTP ${status}). Try again in a little while.`, init);
  }
  if (status === 400) return new SmsTunnelError(`SMSTunnel refused the request: ${said}`, init);
  return new SmsTunnelError(`SMSTunnel answered HTTP ${status}: ${said}`, init);
}

// ─── Inputs ─────────────────────────────────────────────────────────────────

const PHONE_SHAPE = /^[\d\s.\-()+]{7,25}$/;

/**
 * One phone number, as a string. A list (commas, semicolons, new lines, an array) is refused: SMSTunnel sends one
 * text per number, so loop and make one call per number. A JavaScript number is refused too: it has lost its `+`.
 */
export function checkNumber(to: unknown): string {
  if (Array.isArray(to)) throw inputError('One number per text: send one text per number (call this once for each).');
  if (typeof to === 'number' || typeof to === 'bigint') {
    throw inputError('The phone number must be text in international format, such as "+14155550123", not a number.');
  }
  if (typeof to !== 'string' || to.trim() === '') throw inputError('The phone number (to) is missing.');
  const value = to.trim();
  if (/[,;\n\r]/.test(value)) throw inputError('One number per text: send one text per number (call this once for each).');
  if (!PHONE_SHAPE.test(value)) {
    throw inputError(`"${value.slice(0, 40)}" is not a phone number. Use the international format, such as +14155550123.`);
  }
  return value;
}

/** The text: not empty, at most `max` characters. */
export function checkText(message: unknown, max: number = MAX_TEXT_LENGTH): string {
  if (typeof message !== 'string' || message.trim() === '') throw inputError('The text (message) is empty.');
  if (message.length > max) throw inputError(`The text has ${message.length} characters; SMSTunnel takes at most ${max}.`);
  return message;
}

/** An Idempotency-Key: 1 to 255 printable ASCII characters. */
export function checkIdempotencyKey(key: unknown): string | undefined {
  if (key === undefined || key === null || key === '') return undefined;
  if (typeof key !== 'string' || !/^[\x20-\x7e]{1,255}$/.test(key)) {
    throw inputError('The idempotency key must be 1 to 255 printable ASCII characters (a UUID is a good choice).');
  }
  return key;
}

function optionalText(value: unknown): string | undefined {
  if (typeof value === 'number') return String(value);
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

// ─── Client ─────────────────────────────────────────────────────────────────

export interface SmsTunnelClientOptions {
  /** Your SMSTunnel API key (dashboard → Apps → Add an app). Sent only in the `X-API-Key` header. */
  apiKey: string;
  /** Default `https://smstunnel.io`. */
  baseUrl?: string;
  /** The phone that sends, when your account has several (its ID is under Phones). Default: your phone that is online. */
  deviceId?: string;
  /** Completes numbers written without `+` or `00`, such as `"+40"`. It wins over the phone's own country. */
  defaultCountryCode?: string;
  /** Default 30000. */
  timeoutMs?: number;
  /** Sent as `User-Agent` where the runtime allows it. */
  userAgent?: string;
  transport: Transport;
}

export interface SendTextInput {
  /** One number, in international format (`+14155550123`). */
  to: string;
  /** Up to 1600 characters (320 for a sign-in code). */
  message: string;
  /** Send from this phone instead of the default one. */
  deviceId?: string;
  defaultCountryCode?: string;
  /**
   * A retry with the same key within 24 hours gets the first answer back instead of sending a second text.
   * Use one key per text, such as `order-123-placed`.
   */
  idempotencyKey?: string;
}

export interface SentText {
  messageId: string;
  /** `true` when your phone was offline: the text waits in the queue and goes out when the phone is back online. */
  queued: boolean;
  /** `true` when a retry with the same idempotency key got the first answer back (no second text). */
  replayed: boolean;
  /** `true` when SMSTunnel added a short footer (the free allowance for clean texts is used up). */
  branded?: boolean;
  remaining?: unknown;
}

/** `GET /api/v1/sms/status/:id` (the key needs `sms:read`). */
export interface TextStatus {
  id: string;
  phoneNumber: string;
  status: 'pending' | 'sent' | 'delivered' | 'failed';
  /** `unconfirmed`: handed to the SIM without a confirmation. It was most likely sent: don't send it again. */
  deliveryStatus?: 'pending' | 'sent' | 'delivered' | 'failed' | 'unconfirmed';
  unconfirmed?: boolean;
  sentAt?: string;
  deliveredAt?: string;
  errorMessage?: string | null;
  [field: string]: unknown;
}

export interface Phone {
  id: string;
  name: string;
  isOnline: boolean;
  lastSeenAt?: string;
}

export interface PhoneList {
  devices: Phone[];
  online: number;
  total: number;
}

export interface Usage {
  plan: string;
  usage: Record<string, number>;
  limits: Record<string, number | string>;
  remaining: Record<string, number | string>;
  [field: string]: unknown;
}

export class SmsTunnelClient {
  readonly baseUrl: string;
  readonly deviceId?: string;
  readonly defaultCountryCode?: string;
  private readonly timeoutMs: number;
  private readonly userAgent?: string;
  private readonly transport: Transport;
  // Kept out of JSON.stringify and of console.log of the client.
  #apiKey: string;

  constructor(options: SmsTunnelClientOptions) {
    const apiKey = typeof options?.apiKey === 'string' ? options.apiKey.trim() : '';
    if (!apiKey) {
      throw inputError(`The SMSTunnel API key is missing. Create one in your dashboard: ${DASHBOARD_APPS_URL} → Add an app.`);
    }
    const base = (optionalText(options.baseUrl) ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
    if (!/^https?:\/\/[^/\s]+/i.test(base)) throw inputError(`"${base}" is not an http(s) address for SMSTunnel.`);
    this.#apiKey = apiKey;
    this.baseUrl = base;
    this.deviceId = optionalText(options.deviceId);
    this.defaultCountryCode = optionalText(options.defaultCountryCode);
    this.timeoutMs = options.timeoutMs && options.timeoutMs > 0 ? options.timeoutMs : DEFAULT_TIMEOUT_MS;
    this.userAgent = options.userAgent;
    this.transport = options.transport;
  }

  /** Sends one text, from your phone, to one number (`POST /api/v1/sms/send`). */
  sendText(input: SendTextInput): Promise<SentText> {
    return this.send('/api/v1/sms/send', input, MAX_TEXT_LENGTH);
  }

  /**
   * Sends a sign-in or verification code (`POST /api/v1/sms/send-2fa`), counted against the separate allowance for
   * codes. The text must contain the code: 4 to 10 digits on their own (`482913`) or `123-456`, at most 320 characters.
   */
  sendCode(input: SendTextInput): Promise<SentText> {
    return this.send('/api/v1/sms/send-2fa', input, MAX_CODE_TEXT_LENGTH);
  }

  /** Where a text is now (the key needs `sms:read`, which keys from Apps → Add an app have). */
  async getStatus(messageId: string): Promise<TextStatus> {
    const id = optionalText(messageId);
    if (!id) throw inputError('The message id is missing.');
    const answer = await this.call('GET', `/api/v1/sms/status/${encodeURIComponent(id)}`, undefined, {}, false);
    return answer.data as TextStatus;
  }

  /** The phones of your account, and which are online. */
  async listPhones(): Promise<PhoneList> {
    const answer = await this.call('GET', '/api/v1/devices', undefined, {}, false);
    const data = (answer.data ?? {}) as Partial<PhoneList>;
    const devices = Array.isArray(data.devices) ? data.devices : [];
    return { devices, online: data.online ?? devices.filter((d) => d.isOnline).length, total: data.total ?? devices.length };
  }

  /** What your plan allows today and what is left. */
  async getUsage(): Promise<Usage> {
    const answer = await this.call('GET', '/api/v1/account/usage', undefined, {}, false);
    return answer.data as Usage;
  }

  private async send(path: string, input: SendTextInput, max: number): Promise<SentText> {
    if (!input || typeof input !== 'object') throw inputError('Nothing to send: give { to, message }.');
    const to = checkNumber(input.to);
    const message = checkText(input.message, max);
    const idempotencyKey = checkIdempotencyKey(input.idempotencyKey);
    const body: Record<string, string> = { to, message };
    const deviceId = optionalText(input.deviceId) ?? this.deviceId;
    const country = optionalText(input.defaultCountryCode) ?? this.defaultCountryCode;
    if (deviceId) body.deviceId = deviceId;
    if (country) body.defaultCountryCode = country;

    const headers: Record<string, string> = idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {};
    const answer = await this.call('POST', path, body, headers, true);
    const data = (answer.data && typeof answer.data === 'object' ? answer.data : {}) as Record<string, any>;
    const messageId = answer.messageId ?? data.messageId;
    if (typeof messageId !== 'string' || messageId === '') {
      throw new SmsTunnelError('SMSTunnel took the request but gave no message id.', { kind: 'invalid-response', body: answer, mayHaveSent: true });
    }
    const sent: SentText = {
      messageId,
      queued: answer.queued === true || data.queued === true,
      replayed: answer.replayed === true,
    };
    if (typeof data.branded === 'boolean') sent.branded = data.branded;
    if (data.remaining !== undefined) sent.remaining = data.remaining;
    return sent;
  }

  private async call(
    method: 'GET' | 'POST',
    path: string,
    body: unknown,
    extraHeaders: Record<string, string>,
    isSend: boolean,
  ): Promise<Record<string, any>> {
    const headers: Record<string, string> = {
      'X-API-Key': this.#apiKey,
      Accept: 'application/json',
      ...extraHeaders,
    };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (this.userAgent) headers['User-Agent'] = this.userAgent;

    let response: TransportResponse;
    try {
      response = await this.transport({
        method,
        url: this.baseUrl + path,
        headers,
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        timeoutMs: this.timeoutMs,
      });
    } catch (error) {
      throw noAnswer(error, this.baseUrl, this.timeoutMs, isSend);
    }

    const parsed = parseBody(response.body);
    if (response.status < 200 || response.status >= 300) {
      throw httpError(response.status, parsed, response.headers['retry-after'], isSend);
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new SmsTunnelError(
        `The answer from ${this.baseUrl} (HTTP ${response.status}) is not SMSTunnel's JSON. Check the address.`,
        { kind: 'invalid-response', status: response.status, body: parsed, mayHaveSent: isSend },
      );
    }
    const answer = parsed as Record<string, any>;
    if (answer.success === false) {
      throw new SmsTunnelError(`SMSTunnel refused the request: ${errorMessageOf(answer, response.status)}`, {
        kind: 'http',
        status: response.status,
        body: answer,
      });
    }
    if (response.headers['idempotent-replayed'] === 'true') answer.replayed = true;
    return answer;
  }
}

function parseBody(body: unknown): unknown {
  if (typeof body !== 'string') return body;
  if (body.trim() === '') return undefined;
  try {
    return JSON.parse(body);
  } catch {
    return body;
  }
}

function hostOf(baseUrl: string): string {
  const match = /^https?:\/\/([^/]+)/i.exec(baseUrl);
  return match ? match[1] : baseUrl;
}

function noAnswer(error: unknown, baseUrl: string, timeoutMs: number, isSend: boolean): SmsTunnelError {
  const transportError = error instanceof TransportError ? error : undefined;
  const reason = transportError?.reason ?? 'network';
  const mayHaveSent = isSend && (transportError ? transportError.mayHaveArrived : true);
  const first =
    reason === 'timeout'
      ? `SMSTunnel did not answer within ${Math.round(timeoutMs / 1000)} s.`
      : `Could not reach SMSTunnel at ${hostOf(baseUrl)} (${transportError?.systemCode ?? (error as Error)?.message ?? 'network error'}).`;
  const then = mayHaveSent
    ? ` The text may have gone out. ${CHECK_DASHBOARD}`
    : ' Check the connection and the address, then try again.';
  return new SmsTunnelError(first + then, { kind: reason, mayHaveSent });
}
