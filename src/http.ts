import { userAbortError } from "./errors.js";
import { userAgent } from "./userAgent.js";

export interface HttpResponse {
  jsonBody: unknown;
  httpStatus: number;
  requestId: string | null;
  rawText: string;
}

export type FetchLike = typeof globalThis.fetch;

export interface HttpClientOptions {
  apiToken: string;
  fetch?: FetchLike;
  /** Per-call timeout in ms. Defaults: 60_000 standard, 3_600_000 enterprise. */
  defaultTimeoutMs?: number;
}

export const STANDARD_TIMEOUT_MS = 60_000;
export const ENTERPRISE_TIMEOUT_MS = 3_600_000;

/**
 * Node's built-in `fetch` (undici) gives up after 300 s without response
 * headers, or between two chunks of the response body, whatever the
 * request's AbortSignal says.
 */
const UNDICI_DEFAULT_TIMEOUT_MS = 300_000;
const UNDICI_GLOBAL_DISPATCHER = Symbol.for("undici.globalDispatcher.1");

interface UndiciDispatcher {
  dispatch(options: Record<string, unknown>, handler: unknown): boolean;
}

function isUndiciDispatcher(v: unknown): v is UndiciDispatcher {
  return (
    typeof v === "object" &&
    v !== null &&
    typeof (v as { dispatch?: unknown }).dispatch === "function"
  );
}

function isNodeRuntime(): boolean {
  if (typeof process === "undefined" || process.versions === undefined) return false;
  const versions = process.versions as Record<string, string | undefined>;
  return (
    typeof versions["node"] === "string" &&
    versions["bun"] === undefined &&
    (globalThis as { Deno?: unknown }).Deno === undefined
  );
}

let untimedDispatcher: UndiciDispatcher | undefined;

/**
 * A dispatcher for Node's built-in `fetch` that hands each request to the
 * process-wide dispatcher (so one installed with `setGlobalDispatcher`, such
 * as a proxy agent, still applies) with undici's own headers and body
 * timeouts turned off. The SDK's `timeoutMs` abort is then the request's
 * only time limit. `undefined` outside Node.
 */
function getUntimedDispatcher(): UndiciDispatcher | undefined {
  if (!isNodeRuntime()) return undefined;
  const registry = globalThis as unknown as Record<symbol, unknown>;
  const installed = registry[UNDICI_GLOBAL_DISPATCHER];
  if (!isUndiciDispatcher(installed)) return undefined;
  untimedDispatcher ??= {
    dispatch(options, handler) {
      const current = registry[UNDICI_GLOBAL_DISPATCHER];
      const target = isUndiciDispatcher(current) ? current : installed;
      return target.dispatch({ ...options, headersTimeout: 0, bodyTimeout: 0 }, handler);
    },
  };
  return untimedDispatcher;
}

/**
 * Form-data field value. Strings go through directly; Blob carries binary
 * payloads with a filename when constructed via `new File()`.
 */
export type FormFieldValue = string | Blob | undefined;

export class HttpClient {
  private apiToken: string;
  private readonly fetchImpl: FetchLike;
  /** True when no custom `fetch` was supplied and the runtime's own is used. */
  private readonly builtinFetch: boolean;
  private readonly defaultTimeoutMs: number;

  constructor(opts: HttpClientOptions) {
    this.apiToken = opts.apiToken;
    this.builtinFetch = opts.fetch === undefined;
    this.fetchImpl = opts.fetch ?? ((globalThis.fetch as FetchLike).bind(globalThis));
    this.defaultTimeoutMs = opts.defaultTimeoutMs ?? STANDARD_TIMEOUT_MS;
  }

  /** Atomically swap the token used for subsequent requests. */
  setApiToken(newToken: string): void {
    this.apiToken = newToken;
  }

  async postForm(
    url: string,
    fields: Record<string, FormFieldValue>,
    opts: { timeoutMs?: number; signal?: AbortSignal } = {},
  ): Promise<HttpResponse> {
    const form = new FormData();
    form.set("api_token", this.apiToken);
    for (const [k, v] of Object.entries(fields)) {
      if (v === undefined) continue;
      form.set(k, v);
    }
    return this.send(url, { method: "POST", body: form }, opts);
  }

  /**
   * GET with query parameters. Carries no api_token: the one GET endpoint,
   * `/longpoll/`, is authorized by its category, and a token in a URL ends
   * up in proxy and access logs.
   */
  async get(
    url: string,
    params: Record<string, string | undefined>,
    opts: { timeoutMs?: number; signal?: AbortSignal } = {},
  ): Promise<HttpResponse> {
    const u = new URL(url);
    for (const [k, v] of Object.entries(params)) {
      if (v === undefined) continue;
      u.searchParams.set(k, v);
    }
    return this.send(u.toString(), { method: "GET" }, opts);
  }

  private async send(
    url: string,
    init: RequestInit,
    { timeoutMs, signal: userSignal }: { timeoutMs?: number; signal?: AbortSignal },
  ): Promise<HttpResponse> {
    const effectiveTimeoutMs = timeoutMs ?? this.defaultTimeoutMs;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
    }, effectiveTimeoutMs);
    // If user passed a signal, abort our controller when theirs fires.
    const userAbortHandler = (): void => controller.abort();
    if (userSignal !== undefined) {
      if (userSignal.aborted) {
        controller.abort();
      } else {
        userSignal.addEventListener("abort", userAbortHandler, { once: true });
      }
    }
    try {
      const headers = new Headers(init.headers);
      headers.set("User-Agent", userAgent());
      const fetchInit: RequestInit & { dispatcher?: UndiciDispatcher } = {
        ...init,
        headers,
        signal: controller.signal,
      };
      // Requests allowed to run longer than undici's 300 s default (enterprise
      // calls default to 1 hour) would otherwise fail at 300 s with
      // `TypeError: fetch failed`. A custom `fetch` brings its own transport.
      if (this.builtinFetch && effectiveTimeoutMs > UNDICI_DEFAULT_TIMEOUT_MS) {
        const dispatcher = getUntimedDispatcher();
        if (dispatcher !== undefined) fetchInit.dispatcher = dispatcher;
      }
      const response = await this.fetchImpl(url, fetchInit);
      const text = await response.text();
      let json: unknown = null;
      if (text !== "") {
        try {
          json = JSON.parse(text);
        } catch {
          json = null;
        }
      }
      return {
        jsonBody: json,
        httpStatus: response.status,
        requestId: response.headers.get("x-request-id"),
        rawText: text,
      };
    } catch (err) {
      // Distinguish the caller's own cancellation from the SDK timeout abort:
      // user cancellations must not be labelled as timeouts or retried.
      if (
        userSignal?.aborted === true &&
        err !== null &&
        typeof err === "object" &&
        (err as { name?: unknown }).name === "AbortError"
      ) {
        throw userAbortError(err);
      }
      throw err;
    } finally {
      clearTimeout(timer);
      if (userSignal !== undefined) {
        userSignal.removeEventListener("abort", userAbortHandler);
      }
    }
  }
}
