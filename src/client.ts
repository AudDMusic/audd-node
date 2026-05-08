/** Top-level AudD client. */
import {
  AudDConnectionError,
  AudDSerializationError,
  AudDServerError,
  raiseFromErrorResponse,
} from "./errors.js";
import {
  ENTERPRISE_TIMEOUT_MS,
  HttpClient,
  type FetchLike,
  type FormFieldValue,
  type HttpResponse,
} from "./http.js";
import {
  parseEnterpriseChunkResult,
  parseRecognitionResult,
  type EnterpriseMatch,
  type RecognitionResult,
} from "./models.js";
import {
  defaultPolicy,
  retry,
  type RetryClass,
  type RetryPolicy,
} from "./retry.js";
import { prepareSource, type Source } from "./source.js";
import { Streams } from "./streams.js";
import { CustomCatalog } from "./customCatalog.js";
import { Advanced } from "./advanced.js";

const API_BASE = "https://api.audd.io";
const ENTERPRISE_BASE = "https://enterprise.audd.io";

/** Server-side soft-deprecation code. */
const DEPRECATED_PARAMS_CODE = 51;
const HTTP_CLIENT_ERROR_FLOOR = 400;
const TOKEN_ENV_VAR = "AUDD_API_TOKEN";

/**
 * Inspection event kinds emitted by the SDK request lifecycle.
 * Hooks receive these via the `onEvent` callback.
 */
export type AudDEventKind = "request" | "response" | "exception";

/**
 * Inspection event emitted by the SDK request lifecycle.
 * Frozen, plain-data; never includes the api_token or request body bytes.
 */
export interface AudDEvent {
  kind: AudDEventKind;
  /** AudD method name, e.g. "recognize", "addStream". */
  method: string;
  url: string;
  requestId: string | null;
  httpStatus: number | null;
  elapsedMs: number | null;
  errorCode: number | null;
  extras: Record<string, unknown>;
}

export type OnEventHook = (event: AudDEvent) => void;

function safeEmit(hook: OnEventHook | undefined, event: AudDEvent): void {
  if (hook === undefined) return;
  try {
    hook(event);
  } catch {
    // Observability hooks must never break the request path.
  }
}

function resolveToken(apiToken: string | undefined): string {
  if (apiToken !== undefined && apiToken !== "") return apiToken;
  const env = (typeof process !== "undefined" ? process.env[TOKEN_ENV_VAR] : undefined) ?? "";
  if (env !== "") return env;
  throw new Error(
    `AudD apiToken not supplied and ${TOKEN_ENV_VAR} env var is unset. ` +
      "Get a token at https://dashboard.audd.io and pass it as " +
      "new AudD(\"<token>\") (or new AudD({ apiToken: \"<token>\" })), " +
      "or set AUDD_API_TOKEN.",
  );
}

export interface AudDOptions {
  /** Required, but may be omitted if `AUDD_API_TOKEN` is in the environment. */
  apiToken?: string;
  /** Maximum retry attempts (default 3). */
  maxRetries?: number;
  /** Initial backoff in ms (default 500), jittered, exponential. */
  backoffFactorMs?: number;
  /** Custom fetch (e.g., for proxy/mTLS). */
  fetch?: FetchLike;
  /** Inspection hook (see {@link AudDEvent}). Off by default. */
  onEvent?: OnEventHook;
}

export type ReturnMetadata =
  | "apple_music"
  | "spotify"
  | "deezer"
  | "napster"
  | "musicbrainz"
  | string;

export interface RecognizeOptions {
  return?: ReturnMetadata | ReturnMetadata[];
  market?: string;
  /** Per-call timeout in ms; overrides the client default. */
  timeoutMs?: number;
  /**
   * User-supplied AbortSignal for cancellation.
   *
   * **Note:** cancellation aborts the local request. The server may have
   * already done metered work and the credit is consumed regardless.
   */
  signal?: AbortSignal;
}

export interface RecognizeEnterpriseOptions {
  return?: ReturnMetadata | ReturnMetadata[];
  skip?: number;
  every?: number;
  limit?: number;
  skipFirstSeconds?: number;
  useTimecode?: boolean;
  accurateOffsets?: boolean;
  timeoutMs?: number;
  /**
   * User-supplied AbortSignal for cancellation. See {@link RecognizeOptions.signal}.
   * For multi-hour enterprise calls, this is the right way to cancel.
   */
  signal?: AbortSignal;
}

function formatReturn(value: ReturnMetadata | ReturnMetadata[] | undefined): string | undefined {
  if (value === undefined) return undefined;
  return Array.isArray(value) ? value.join(",") : value;
}

function buildEnterpriseFields(opts: RecognizeEnterpriseOptions): Record<string, string> {
  const fields: Record<string, string> = {};
  const ret = formatReturn(opts.return);
  if (ret !== undefined) fields["return"] = ret;
  if (opts.skip !== undefined) fields["skip"] = String(opts.skip);
  if (opts.every !== undefined) fields["every"] = String(opts.every);
  if (opts.limit !== undefined) fields["limit"] = String(opts.limit);
  if (opts.skipFirstSeconds !== undefined)
    fields["skip_first_seconds"] = String(opts.skipFirstSeconds);
  if (opts.useTimecode !== undefined) fields["use_timecode"] = opts.useTimecode ? "true" : "false";
  if (opts.accurateOffsets !== undefined)
    fields["accurate_offsets"] = opts.accurateOffsets ? "true" : "false";
  return fields;
}

interface MaybeError {
  status?: unknown;
  error?: { error_code?: number; error_message?: string } | undefined;
  result?: unknown;
}

function isDeprecationPassThrough(body: MaybeError): boolean {
  return body.error?.error_code === DEPRECATED_PARAMS_CODE && body.result != null;
}

function maybeWarnAndStrip(body: MaybeError): void {
  if (!isDeprecationPassThrough(body)) return;
  const msg = body.error?.error_message ?? "Deprecated parameter used";
  // Mirror audd-python behaviour: emit a warning, then look like a success.
  console.warn(`audd: deprecated parameter — ${msg}`);
  delete body.error;
  body.status = "success";
}

/**
 * Inspect a response, raise typed errors for obvious failures, else return
 * the body dict. Mirror of `audd-python` `_decode_or_raise`.
 *
 * Distinguishes:
 * - non-2xx HTTP with non-JSON body → AudDServerError (preserves status)
 * - 2xx with non-JSON body → AudDSerializationError
 * - status=error with code-51 + result → emit warning, strip, fall through
 * - status=error otherwise → raise typed exception
 * - status=success or stripped → return body
 */
export function decodeOrRaise(resp: HttpResponse): Record<string, unknown> {
  const body = resp.jsonBody;
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    if (resp.httpStatus >= HTTP_CLIENT_ERROR_FLOOR) {
      throw new AudDServerError({
        errorCode: 0,
        message: `HTTP ${String(resp.httpStatus)} with non-JSON response body`,
        httpStatus: resp.httpStatus,
        requestId: resp.requestId,
        rawResponse: resp.rawText,
      });
    }
    throw new AudDSerializationError("Unparseable response", resp.rawText);
  }
  const obj = body as Record<string, unknown> & MaybeError;
  maybeWarnAndStrip(obj);

  if (obj.status === "error") {
    raiseFromErrorResponse(obj, {
      httpStatus: resp.httpStatus,
      requestId: resp.requestId,
    });
  }
  if (obj.status === "success") {
    return obj;
  }
  throw new AudDServerError({
    errorCode: 0,
    message: `Unexpected response status: ${JSON.stringify(obj.status)}`,
    httpStatus: resp.httpStatus,
    requestId: resp.requestId,
    rawResponse: obj,
  });
}

function decodeRecognize(resp: HttpResponse): RecognitionResult | null {
  const body = decodeOrRaise(resp);
  const result = body["result"];
  if (result == null) return null;
  return parseRecognitionResult(result);
}

function decodeEnterprise(resp: HttpResponse): EnterpriseMatch[] {
  const body = decodeOrRaise(resp);
  const chunks = body["result"];
  if (!Array.isArray(chunks)) return [];
  const out: EnterpriseMatch[] = [];
  for (const c of chunks) {
    const chunk = parseEnterpriseChunkResult(c);
    out.push(...chunk.songs);
  }
  return out;
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

/**
 * The AudD client. Async-only — every method returns a `Promise`.
 *
 * ```ts
 * const audd = new AudD({ apiToken: "test" });
 * const result = await audd.recognize("https://audd.tech/example.mp3");
 * ```
 *
 * Closes underlying resources via `close()` (or `[Symbol.asyncDispose]` if
 * the runtime supports explicit-resource-management).
 */
export class AudD {
  private readonly _http: HttpClient;
  private readonly _enterpriseHttp: HttpClient;
  private readonly _maxRetries: number;
  private readonly _backoffFactorMs: number;
  private _apiToken: string;
  private _onEvent: OnEventHook | undefined;
  private _streams: Streams | undefined;
  private _customCatalog: CustomCatalog | undefined;
  private _advanced: Advanced | undefined;

  /** Construct with just an api_token. Falls back to AUDD_API_TOKEN env var if omitted. */
  constructor(apiToken?: string);
  /** Construct with an api_token and additional options (timeouts, retries, custom fetch, onEvent hook). */
  constructor(apiToken: string, opts: Omit<AudDOptions, "apiToken">);
  /** Construct with an options object (any combination of apiToken + extras). */
  constructor(opts: AudDOptions);
  constructor(arg?: string | AudDOptions, extra?: Omit<AudDOptions, "apiToken">) {
    const opts: AudDOptions =
      typeof arg === "string"
        ? { apiToken: arg, ...(extra ?? {}) }
        : (arg ?? {});
    const token = resolveToken(opts.apiToken);
    this._apiToken = token;
    this._onEvent = opts.onEvent;
    this._maxRetries = opts.maxRetries ?? 3;
    this._backoffFactorMs = (opts.backoffFactorMs ?? 500);
    this._http = new HttpClient({
      apiToken: token,
      ...(opts.fetch !== undefined ? { fetch: opts.fetch } : {}),
    });
    this._enterpriseHttp = new HttpClient({
      apiToken: token,
      ...(opts.fetch !== undefined ? { fetch: opts.fetch } : {}),
      defaultTimeoutMs: ENTERPRISE_TIMEOUT_MS,
    });
  }

  /** Current api_token. Returns the in-effect token after any rotations. */
  get apiToken(): string {
    return this._apiToken;
  }

  /**
   * Rotate the api_token used for subsequent requests. In-flight requests
   * continue with the old token (no abort).
   */
  setApiToken(newToken: string): void {
    if (typeof newToken !== "string" || newToken === "") {
      throw new Error("setApiToken requires a non-empty string");
    }
    this._apiToken = newToken;
    this._http.setApiToken(newToken);
    this._enterpriseHttp.setApiToken(newToken);
    // Streams namespace caches the token via a getter; nothing to flush there.
  }

  private policyFor(retryClass: RetryClass): RetryPolicy {
    return {
      ...defaultPolicy(retryClass),
      maxAttempts: this._maxRetries,
      backoffFactorMs: this._backoffFactorMs,
    };
  }

  /** Sub-namespace for stream management + longpoll. Lazy-instantiated. */
  get streams(): Streams {
    if (this._streams === undefined) {
      this._streams = new Streams(
        this._http,
        this.policyFor("read"),
        this.policyFor("mutating"),
        this._apiToken,
      );
    }
    return this._streams;
  }

  /** Sub-namespace for the private fingerprint catalog. NOT for recognition. */
  get customCatalog(): CustomCatalog {
    if (this._customCatalog === undefined) {
      // "none" — custom-catalog upload is metered; never retry on transport
      // failure (could double-charge). Surface a clean error instead.
      this._customCatalog = new CustomCatalog(this._http, this.policyFor("none"));
    }
    return this._customCatalog;
  }

  /** Lyrics search + raw-request escape hatch. */
  get advanced(): Advanced {
    if (this._advanced === undefined) {
      // RECOGNITION policy: findLyrics is metered.
      this._advanced = new Advanced(this._http, this.policyFor("recognition"));
    }
    return this._advanced;
  }

  /**
   * Recognize a short audio clip (≤25s) from a URL, file path, Blob, or bytes.
   *
   * Returns `null` when the server returns `status=success` with `result=null`
   * (no match) — distinct from a thrown error.
   */
  async recognize(source: Source, opts: RecognizeOptions = {}): Promise<RecognitionResult | null> {
    const reopen = prepareSource(source);
    const ret = formatReturn(opts.return);
    const market = opts.market;

    const policy = this.policyFor("recognition");
    const url = `${API_BASE}/`;
    const startedAt = Date.now();
    safeEmit(this._onEvent, {
      kind: "request", method: "recognize", url,
      requestId: null, httpStatus: null, elapsedMs: null, errorCode: null, extras: {},
    });

    let resp;
    try {
      resp = await runRetried(async () => {
        const prepared = await reopen();
        const fields: Record<string, FormFieldValue> = { ...prepared.fields };
        if (ret !== undefined) fields["return"] = ret;
        if (market !== undefined) fields["market"] = market;
        return this._http.postForm(url, fields, {
          ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
          ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
        });
      }, policy);
    } catch (err) {
      safeEmit(this._onEvent, {
        kind: "exception", method: "recognize", url,
        requestId: null, httpStatus: null,
        elapsedMs: Date.now() - startedAt, errorCode: null,
        extras: { name: (err instanceof Error ? err.name : String(err)) },
      });
      throw err;
    }
    safeEmit(this._onEvent, {
      kind: "response", method: "recognize", url,
      requestId: resp.requestId, httpStatus: resp.httpStatus,
      elapsedMs: Date.now() - startedAt, errorCode: null, extras: {},
    });

    return decodeRecognize(resp);
  }

  /**
   * Enterprise recognition (long files). Returns a flat array of matches
   * across all chunks in the upstream response.
   *
   * Recommended: pass `limit: N` to cap result count when developing.
   */
  async recognizeEnterprise(
    source: Source,
    opts: RecognizeEnterpriseOptions = {},
  ): Promise<EnterpriseMatch[]> {
    const reopen = prepareSource(source);
    const extra = buildEnterpriseFields(opts);

    const policy = this.policyFor("recognition");
    const resp = await runRetried(async () => {
      const prepared = await reopen();
      const fields: Record<string, FormFieldValue> = { ...prepared.fields, ...extra };
      return this._enterpriseHttp.postForm(`${ENTERPRISE_BASE}/`, fields, {
        ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
        ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
      });
    }, policy);

    return decodeEnterprise(resp);
  }

  /** Release any underlying resources. (Currently a no-op for `fetch`-based transport.) */
  close(): void {
    /* fetch has no persistent connection pool to close */
  }

  async [Symbol.asyncDispose](): Promise<void> {
    this.close();
    await Promise.resolve();
  }
}
