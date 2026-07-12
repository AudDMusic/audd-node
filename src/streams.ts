/** Streams namespace — setCallbackUrl, addStream, longpoll with preflight, etc. */
import { addReturnToUrl, deriveLongpollCategory, parseCallback } from "./helpers.js";
import {
  AudDAPIError,
  AudDInvalidRequestError,
  AudDSerializationError,
  AudDServerError,
  raiseFromErrorResponse,
} from "./errors.js";
import { emitAround, type OnEventHook } from "./events.js";
import type { HttpClient } from "./http.js";
import { startLongpoll, type LongpollPoll } from "./longpollCore.js";
import { asObject, parseStream, type Stream } from "./models.js";
import { runRetried, type RetryPolicy } from "./retry.js";
import type { ParsedCallback } from "./helpers.js";

const API_BASE = "https://api.audd.io";

/**
 * Extra transport headroom on top of the server-side longpoll timeout, so a
 * poll of N seconds isn't cut off by the SDK's own HTTP timeout.
 */
const LONGPOLL_TIMEOUT_MARGIN_SEC = 10;

/** Server signals "no callback URL configured" with code 19 from getCallbackUrl. */
const NO_CALLBACK_ERROR_CODE = 19;

const PREFLIGHT_NO_CALLBACK_HINT =
  "Longpoll won't deliver events because no callback URL is configured for this " +
  "account. Set one first via streams.setCallbackUrl(...) — `https://audd.tech/empty/` " +
  "is fine if you only want longpolling and don't need a real receiver. To skip this " +
  "check, pass skipCallbackCheck: true.";

export interface SetCallbackUrlOptions {
  returnMetadata?: string | string[];
  /**
   * Additional form fields the typed options don't cover. Typed options
   * (`url`) win on collision.
   */
  extraParameters?: Record<string, string>;
}

export interface AddStreamOptions {
  url: string;
  radioId: number;
  /** "before" delivers callbacks at song start; default delivers at song end. */
  callbacks?: "before" | string;
  /**
   * Additional form fields the typed options don't cover. Typed options
   * (`url`, `radioId`, `callbacks`) win on collision.
   */
  extraParameters?: Record<string, string>;
}

export interface LongpollOptions {
  sinceTime?: number;
  /** Server-side timeout in seconds (default 50). */
  timeout?: number;
  /** Bypass the default-on `getCallbackUrl` preflight. */
  skipCallbackCheck?: boolean;
  /**
   * Radio id to subscribe to — the SDK derives the 9-char category locally
   * from `(api_token, radio_id)`. Mutually exclusive with `category`. Only
   * meaningful on the object-form call site (`longpoll({ radioId: 42 })`).
   */
  radioId?: number;
  /**
   * Pre-derived 9-char longpoll category. Mutually exclusive with `radioId`.
   * Only meaningful on the object-form call site
   * (`longpoll({ category: "abc123def" })`); the positional string form
   * `longpoll("abc123def")` is the more common way to pass a category.
   */
  category?: string;
}

function decodeSuccess(
  body: unknown,
  httpStatus: number,
  requestId: string | null,
): unknown {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new AudDSerializationError("Unparseable response");
  }
  const obj = body as Record<string, unknown> & {
    status?: unknown;
    error?: unknown;
    result?: unknown;
  };
  if (obj.status === "error") {
    raiseFromErrorResponse(obj as Parameters<typeof raiseFromErrorResponse>[0], {
      httpStatus,
      requestId,
    });
  }
  if (obj.status === "success") {
    return obj.result;
  }
  throw new AudDServerError({
    errorCode: 0,
    message: `Unexpected response status: ${JSON.stringify(obj.status)}`,
    httpStatus,
    requestId,
    rawResponse: obj,
  });
}

export class Streams {
  constructor(
    private readonly http: HttpClient,
    private readonly readPolicy: RetryPolicy,
    private readonly mutatingPolicy: RetryPolicy,
    /** Live token provider — token rotations on the client propagate here. */
    private readonly apiToken: () => string,
    private readonly onEvent?: OnEventHook,
  ) {}

  private async post(
    path: string,
    fields: Record<string, string | undefined>,
    policy: RetryPolicy,
  ): Promise<unknown> {
    const url = `${API_BASE}/${path}/`;
    const resp = await emitAround(this.onEvent, path, url, () =>
      runRetried(() => this.http.postForm(url, fields), policy),
    );
    return decodeSuccess(resp.jsonBody, resp.httpStatus, resp.requestId);
  }

  /**
   * Set the callback URL where AudD will POST recognition events.
   *
   * @param url   The URL to register.
   * @param opts.returnMetadata Optional metadata block list — appended as
   * `?return=...` to the URL. Raises `DuplicateReturnParameterError` if the
   * URL already contains a `?return=` parameter.
   */
  async setCallbackUrl(url: string, opts: SetCallbackUrlOptions = {}): Promise<void> {
    const finalUrl = addReturnToUrl(url, opts.returnMetadata);
    // extraParameters first; typed fields (`url`) win on collision.
    const fields: Record<string, string> = opts.extraParameters
      ? { ...opts.extraParameters }
      : {};
    fields["url"] = finalUrl;
    await this.post("setCallbackUrl", fields, this.mutatingPolicy);
  }

  /** Get the currently registered callback URL. */
  async getCallbackUrl(): Promise<string> {
    const result = await this.post("getCallbackUrl", {}, this.readPolicy);
    return String(result);
  }

  /** Register a new stream for real-time recognition. */
  async add(opts: AddStreamOptions): Promise<void> {
    // extraParameters first; typed fields win on collision.
    const fields: Record<string, string | undefined> = opts.extraParameters
      ? { ...opts.extraParameters }
      : {};
    fields["url"] = opts.url;
    fields["radio_id"] = String(opts.radioId);
    if (opts.callbacks !== undefined) fields["callbacks"] = opts.callbacks;
    await this.post("addStream", fields, this.mutatingPolicy);
  }

  /** Update the upstream URL of an existing stream. */
  async setUrl(radioId: number, url: string): Promise<void> {
    await this.post(
      "setStreamUrl",
      { radio_id: String(radioId), url },
      this.mutatingPolicy,
    );
  }

  /** Delete an existing stream. */
  async delete(radioId: number): Promise<void> {
    await this.post("deleteStream", { radio_id: String(radioId) }, this.mutatingPolicy);
  }

  /** List all streams on this account. */
  async list(): Promise<Stream[]> {
    const result = await this.post("getStreams", {}, this.readPolicy);
    if (!Array.isArray(result)) return [];
    // Skip wrong-typed entries instead of failing the whole list.
    return result.filter((x) => asObject(x) !== undefined).map(parseStream);
  }

  /** Compute the 9-char longpoll category locally — pure, no network. */
  deriveLongpollCategory(radioId: number): string {
    return deriveLongpollCategory(this.apiToken(), radioId);
  }

  /**
   * Parse a callback POST body into `{ match, notification }`. Pass an
   * already-parsed JSON value or a string. Exactly one field is non-null on
   * success. See {@link parseCallback} for details.
   */
  parseCallback(body: unknown): ParsedCallback {
    return parseCallback(body);
  }

  /**
   * Long-poll the AudD subscription endpoint.
   *
   * Two call shapes:
   *
   * - **Common case** — pass an options object with `radioId`; the SDK
   *   derives the 9-char category locally from `(api_token, radio_id)`:
   *   `longpoll({ radioId: 42 })`.
   * - **Tokenless / pre-derived category** — pass the category as a positional
   *   string (`longpoll("abc123def")`) or via the object form
   *   (`longpoll({ category: "abc123def" })`). Useful when the category was
   *   shared with you (e.g. a browser/mobile client running without the
   *   api_token).
   *
   * Returns a {@link LongpollPoll} handle with three async-iterables —
   * `matches`, `notifications`, `errors` — that are filled by a background
   * loop. Iterate them independently or in parallel via `Promise.all([...])`.
   *
   * Before the first request the SDK runs a one-time `getCallbackUrl`
   * preflight: AudD silently discards events for accounts that haven't set a
   * callback URL, and the preflight surfaces that misconfiguration as an
   * actionable {@link AudDInvalidRequestError}. Pass `skipCallbackCheck: true`
   * to bypass.
   *
   * Throws {@link AudDInvalidRequestError} if the object form supplies both
   * `radioId` and `category`, or neither.
   */
  async longpoll(category: string, opts?: LongpollOptions): Promise<LongpollPoll>;
  async longpoll(
    opts: LongpollOptions & ({ radioId: number } | { category: string }),
  ): Promise<LongpollPoll>;
  async longpoll(
    arg1: string | (LongpollOptions & { radioId?: number; category?: string }),
    opts: LongpollOptions = {},
  ): Promise<LongpollPoll> {
    let category: string;
    let effectiveOpts: LongpollOptions;
    if (typeof arg1 === "string") {
      category = arg1;
      effectiveOpts = opts;
    } else {
      effectiveOpts = arg1;
      const hasRadioId = arg1.radioId !== undefined;
      const hasCategory = arg1.category !== undefined;
      if (hasRadioId && hasCategory) {
        throw new AudDInvalidRequestError({
          errorCode: 0,
          message:
            "longpoll(): pass exactly one of `radioId` or `category` — got both.",
          httpStatus: 0,
        });
      }
      if (!hasRadioId && !hasCategory) {
        throw new AudDInvalidRequestError({
          errorCode: 0,
          message:
            "longpoll(): pass exactly one of `radioId` or `category` — got neither.",
          httpStatus: 0,
        });
      }
      category = hasRadioId
        ? this.deriveLongpollCategory(arg1.radioId as number)
        : (arg1.category as string);
    }
    if (effectiveOpts.skipCallbackCheck !== true) {
      await this.preflightCallbackUrl();
    }
    const timeoutSec = effectiveOpts.timeout ?? 50;
    const httpClient = this.http;
    const readPolicy = this.readPolicy;
    const onEvent = this.onEvent;
    const longpollUrl = `${API_BASE}/longpoll/`;
    // The HTTP timeout must outlast the server-side poll window, whatever
    // `timeout` the caller picked.
    const timeoutMs = (timeoutSec + LONGPOLL_TIMEOUT_MARGIN_SEC) * 1000;
    return startLongpoll({
      category,
      timeout: timeoutSec,
      sinceTime: effectiveOpts.sinceTime,
      fetchOnce: (params, signal) =>
        emitAround(onEvent, "longpoll", longpollUrl, () =>
          runRetried(
            () => httpClient.get(longpollUrl, params, { signal, timeoutMs }),
            readPolicy,
          ),
        ),
    });
  }

  private async preflightCallbackUrl(): Promise<void> {
    try {
      await this.getCallbackUrl();
    } catch (err) {
      if (err instanceof AudDAPIError && err.errorCode === NO_CALLBACK_ERROR_CODE) {
        throw new AudDInvalidRequestError({
          errorCode: 0,
          message: PREFLIGHT_NO_CALLBACK_HINT,
          httpStatus: err.httpStatus,
          requestId: err.requestId,
        });
      }
      throw err;
    }
  }
}
