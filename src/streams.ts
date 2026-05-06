/** Streams namespace — setCallbackUrl, addStream, longpoll with preflight, etc. */
import { addReturnToUrl, deriveLongpollCategory, parseCallback } from "./helpers.js";
import {
  AudDAPIError,
  AudDConnectionError,
  AudDInvalidRequestError,
  AudDSerializationError,
  AudDServerError,
  raiseFromErrorResponse,
} from "./errors.js";
import type { HttpClient, HttpResponse } from "./http.js";
import { startLongpoll, type LongpollPoll } from "./longpollCore.js";
import { parseStream, type Stream } from "./models.js";
import { retry, type RetryPolicy } from "./retry.js";
import type { ParsedCallback } from "./helpers.js";

const API_BASE = "https://api.audd.io";

/** Server signals "no callback URL configured" with code 19 from getCallbackUrl. */
const NO_CALLBACK_ERROR_CODE = 19;

const PREFLIGHT_NO_CALLBACK_HINT =
  "Longpoll won't deliver events because no callback URL is configured for this " +
  "account. Set one first via streams.setCallbackUrl(...) — `https://audd.tech/empty/` " +
  "is fine if you only want longpolling and don't need a real receiver. To skip this " +
  "check, pass skipCallbackCheck: true.";

export interface SetCallbackUrlOptions {
  returnMetadata?: string | string[];
}

export interface AddStreamOptions {
  url: string;
  radioId: number;
  /** "before" delivers callbacks at song start; default delivers at song end. */
  callbacks?: "before" | string;
}

export interface LongpollOptions {
  sinceTime?: number;
  /** Server-side timeout in seconds (default 50). */
  timeout?: number;
  /** Bypass the default-on `getCallbackUrl` preflight. */
  skipCallbackCheck?: boolean;
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

async function runRetried<T extends HttpResponse>(
  fn: () => Promise<T>,
  policy: RetryPolicy,
): Promise<T> {
  try {
    return await retry(fn, policy);
  } catch (err) {
    if (err instanceof TypeError) {
      throw new AudDConnectionError(`Network error: ${err.message}`, err);
    }
    if (err !== null && typeof err === "object" && (err as { name?: string }).name === "AbortError") {
      throw new AudDConnectionError("Request was aborted (timeout)", err);
    }
    throw err;
  }
}

export class Streams {
  constructor(
    private readonly http: HttpClient,
    private readonly readPolicy: RetryPolicy,
    private readonly mutatingPolicy: RetryPolicy,
    private readonly apiToken: string,
  ) {}

  private async post(
    path: string,
    fields: Record<string, string | undefined>,
    policy: RetryPolicy,
  ): Promise<unknown> {
    const resp = await runRetried(
      () => this.http.postForm(`${API_BASE}/${path}/`, fields),
      policy,
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
    await this.post("setCallbackUrl", { url: finalUrl }, this.mutatingPolicy);
  }

  /** Get the currently registered callback URL. */
  async getCallbackUrl(): Promise<string> {
    const result = await this.post("getCallbackUrl", {}, this.readPolicy);
    return String(result);
  }

  /** Register a new stream for real-time recognition. */
  async add(opts: AddStreamOptions): Promise<void> {
    const fields: Record<string, string | undefined> = {
      url: opts.url,
      radio_id: String(opts.radioId),
    };
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
    return result.map(parseStream);
  }

  /** Compute the 9-char longpoll category locally — pure, no network. */
  deriveLongpollCategory(radioId: number): string {
    return deriveLongpollCategory(this.apiToken, radioId);
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
   * Returns a {@link LongpollPoll} handle with three async-iterables —
   * `matches`, `notifications`, `errors` — that are filled by a background
   * loop. Iterate them independently or in parallel via `Promise.all([...])`.
   *
   * Before the first request the SDK runs a one-time `getCallbackUrl`
   * preflight: AudD silently discards events for accounts that haven't set a
   * callback URL, and the preflight surfaces that misconfiguration as an
   * actionable {@link AudDInvalidRequestError}. Pass `skipCallbackCheck: true`
   * to bypass.
   */
  async longpoll(category: string, opts: LongpollOptions = {}): Promise<LongpollPoll> {
    if (opts.skipCallbackCheck !== true) {
      await this.preflightCallbackUrl();
    }
    const timeoutSec = opts.timeout ?? 50;
    const httpClient = this.http;
    const readPolicy = this.readPolicy;
    return startLongpoll({
      category,
      timeout: timeoutSec,
      sinceTime: opts.sinceTime,
      fetchOnce: (params, signal) =>
        runRetried(
          () => httpClient.get(`${API_BASE}/longpoll/`, params, { signal }),
          readPolicy,
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
