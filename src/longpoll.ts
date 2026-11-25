/**
 * Tokenless longpoll consumer for browser/widget/extension use cases.
 *
 * Carries no api_token. The category alone authorizes the subscription. The
 * user/server who derived the category is responsible for ensuring a
 * callback URL is set on their account (we can't preflight that without a
 * token).
 *
 * Behavior:
 * - Events arrive on `matches` / `notifications` in server order; each
 *   request sends the newest event timestamp as `since_time`.
 * - Connection failures, HTTP 408/429 and 5xx are retried with backoff,
 *   configurable via `maxRetries` / `backoffFactorMs`.
 * - HTTP 4xx, a failure that outlasts the retries, or an error body from
 *   the server (an {@link AudDInvalidRequestError} carrying its text) stops
 *   the poll and arrives once on the `errors` iterable.
 * - A 2xx response it can't read (empty, non-JSON, unknown shape) delays the
 *   next request: 1 s, doubling up to 30 s.
 * - `[Symbol.asyncDispose]()` + manual `close()` for resource cleanup.
 *
 * Imported from `@audd/sdk/longpoll` (browser-safe sub-entry, NOT the main
 * `@audd/sdk` module — bundlers tree-shake the auth client out).
 */

import { userAbortError } from "./errors.js";
import type { FetchLike, HttpResponse } from "./http.js";
import {
  startLongpoll,
  type LongpollPoll,
} from "./longpollCore.js";
import { defaultPolicy, runRetried, type RetryPolicy } from "./retry.js";
import { userAgent } from "./userAgent.js";

export type { LongpollPoll } from "./longpollCore.js";

const LONGPOLL_URL = "https://api.audd.io/longpoll/";

export interface LongpollConsumerOptions {
  /** Maximum retry attempts (default 3). */
  maxRetries?: number;
  /** Initial backoff in ms (default 500), jittered, exponential. */
  backoffFactorMs?: number;
  /** Custom fetch (e.g., for proxy/mTLS). */
  fetch?: FetchLike;
}

export interface IterateOptions {
  /** Server timestamp (ms) to resume from: only newer events are delivered. */
  sinceTime?: number;
  /** Seconds the server holds each request open waiting for events, 1 to 120 (default 50). */
  timeout?: number;
}

/**
 * `User-Agent` is set on Node only. A browser that lets scripts set it
 * would turn every request into a CORS preflight the endpoint doesn't allow.
 */
function requestHeaders(): Record<string, string> {
  const isNode =
    typeof process !== "undefined" &&
    process.versions !== undefined &&
    typeof process.versions.node === "string";
  return isNode ? { "User-Agent": userAgent() } : {};
}

/**
 * Tokenless longpoll consumer.
 *
 * ```ts
 * import { LongpollConsumer } from "@audd/sdk/longpoll";
 *
 * const consumer = new LongpollConsumer("abc123def");
 * const poll = consumer.iterate({ timeout: 30 });
 * for await (const m of poll.matches) {
 *   console.log(m.song?.artist ?? "?", m.song?.title ?? "?");
 * }
 * // `matches` ends when the poll stops; if an error stopped it, `errors` has it.
 * for await (const err of poll.errors) throw err;
 * ```
 *
 * Or iterate matches and notifications concurrently:
 *
 * ```ts
 * await Promise.all([
 *   (async () => { for await (const m of poll.matches) { ... } })(),
 *   (async () => { for await (const n of poll.notifications) { ... } })(),
 * ]);
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

  iterate(opts: IterateOptions = {}): LongpollPoll {
    const fetchImpl = this.fetchImpl;
    const policy = this.policy;
    const timeoutSec = opts.timeout ?? 50;

    const fetchOnceRaw = async (
      params: Record<string, string | undefined>,
      signal: AbortSignal,
    ): Promise<HttpResponse> => {
      const u = new URL(LONGPOLL_URL);
      for (const [k, v] of Object.entries(params)) {
        if (v !== undefined) u.searchParams.set(k, v);
      }
      const response = await fetchImpl(u.toString(), {
        method: "GET",
        headers: requestHeaders(),
        signal,
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
    };

    const fetchOnce = (
      params: Record<string, string | undefined>,
      signal: AbortSignal,
    ): Promise<HttpResponse> =>
      runRetried(async () => {
        try {
          return await fetchOnceRaw(params, signal);
        } catch (err) {
          // The only abort source here is the poll handle's own close() —
          // a caller cancellation. Mark it so it is never retried.
          if (
            signal.aborted &&
            err !== null &&
            typeof err === "object" &&
            (err as { name?: unknown }).name === "AbortError"
          ) {
            throw userAbortError(err);
          }
          throw err;
        }
      }, policy);

    return startLongpoll({
      category: this.category,
      timeout: timeoutSec,
      sinceTime: opts.sinceTime,
      fetchOnce,
    });
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
