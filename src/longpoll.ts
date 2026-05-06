/**
 * Tokenless longpoll consumer for browser/widget/extension use cases.
 *
 * Carries no api_token. The category alone authorizes the subscription. The
 * user/server who derived the category is responsible for ensuring a
 * callback URL is set on their account (we can't preflight that without a
 * token).
 *
 * Behavior:
 * - HTTP non-2xx → throws `AudDServerError` (no silent infinite loop)
 * - JSON decode failure on 2xx → throws `AudDSerializationError`
 * - READ-class retries on 5xx + connection failures, configurable via
 *   `maxRetries` / `backoffFactorMs`
 * - `[Symbol.asyncDispose]()` + manual `close()` for resource cleanup
 *
 * Imported from `audd/longpoll` (browser-safe sub-entry, NOT the main
 * `audd` module — bundlers tree-shake the auth client out).
 */

import {
  AudDConnectionError,
  AudDSerializationError,
  AudDServerError,
} from "./errors.js";
import type { FetchLike, HttpResponse } from "./http.js";
import { defaultPolicy, retry, type RetryPolicy } from "./retry.js";
import { userAgent } from "./userAgent.js";

const LONGPOLL_URL = "https://api.audd.io/longpoll/";
const HTTP_CLIENT_ERROR_FLOOR = 400;
const DEFAULT_TIMEOUT_MS = 120_000;

export interface LongpollConsumerOptions {
  /** Maximum retry attempts (default 3). */
  maxRetries?: number;
  /** Initial backoff in ms (default 500), jittered, exponential. */
  backoffFactorMs?: number;
  /** Custom fetch (e.g., for proxy/mTLS). */
  fetch?: FetchLike;
}

export interface IterateOptions {
  sinceTime?: number;
  /** Server-side timeout in seconds (default 50). */
  timeout?: number;
}

function decode(
  jsonBody: unknown,
  httpStatus: number,
  rawText: string,
): Record<string, unknown> {
  if (httpStatus >= HTTP_CLIENT_ERROR_FLOOR) {
    throw new AudDServerError({
      errorCode: 0,
      message: `Longpoll endpoint returned HTTP ${String(httpStatus)}`,
      httpStatus,
      requestId: null,
      rawResponse: jsonBody ?? rawText,
    });
  }
  if (typeof jsonBody !== "object" || jsonBody === null || Array.isArray(jsonBody)) {
    throw new AudDSerializationError("Longpoll response was not a JSON object", rawText);
  }
  return jsonBody as Record<string, unknown>;
}

/**
 * Tokenless async longpoll consumer.
 *
 * ```ts
 * import { LongpollConsumer } from 'audd/longpoll';
 *
 * const consumer = new LongpollConsumer("abc123def");
 * for await (const event of consumer.iterate({ timeout: 30 })) {
 *   console.log(event);
 * }
 * ```
 */
export class LongpollConsumer {
  private readonly fetchImpl: FetchLike;
  private readonly policy: RetryPolicy;

  constructor(public readonly category: string, opts: LongpollConsumerOptions = {}) {
    this.fetchImpl = opts.fetch ?? ((globalThis.fetch as FetchLike).bind(globalThis));
    const base = defaultPolicy("read");
    this.policy = {
      ...base,
      maxAttempts: opts.maxRetries ?? base.maxAttempts,
      backoffFactorMs: opts.backoffFactorMs ?? base.backoffFactorMs,
    };
  }

  iterate(opts: IterateOptions = {}): AsyncIterable<Record<string, unknown>> {
    const category = this.category;
    const policy = this.policy;
    const fetchImpl = this.fetchImpl;
    const initialSince = opts.sinceTime;
    const timeoutSec = opts.timeout ?? 50;

    async function fetchOnce(curSince: number | undefined): Promise<HttpResponse> {
      const u = new URL(LONGPOLL_URL);
      u.searchParams.set("category", category);
      u.searchParams.set("timeout", String(timeoutSec));
      if (curSince !== undefined) u.searchParams.set("since_time", String(curSince));

      const controller = new AbortController();
      const timer = setTimeout(() => {
        controller.abort();
      }, DEFAULT_TIMEOUT_MS);
      try {
        const response = await fetchImpl(u.toString(), {
          method: "GET",
          headers: { "User-Agent": userAgent() },
          signal: controller.signal,
        });
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
      } finally {
        clearTimeout(timer);
      }
    }

    return {
      [Symbol.asyncIterator](): AsyncIterator<Record<string, unknown>> {
        let curSince = initialSince;
        return {
          async next(): Promise<IteratorResult<Record<string, unknown>>> {
            let resp;
            try {
              resp = await retry(() => fetchOnce(curSince), policy);
            } catch (err) {
              if (err instanceof TypeError) {
                throw new AudDConnectionError(`Network error: ${err.message}`, err);
              }
              if (
                err !== null &&
                typeof err === "object" &&
                (err as { name?: string }).name === "AbortError"
              ) {
                throw new AudDConnectionError("Request was aborted (timeout)", err);
              }
              throw err;
            }
            const body = decode(resp.jsonBody, resp.httpStatus, resp.rawText);
            const ts = body["timestamp"];
            if (typeof ts === "number") curSince = ts;
            return { value: body, done: false };
          },
        };
      },
    };
  }

  /** Release any underlying resources. */
  close(): void {
    /* no persistent connections in fetch */
  }

  async [Symbol.asyncDispose](): Promise<void> {
    this.close();
    await Promise.resolve();
  }
}
