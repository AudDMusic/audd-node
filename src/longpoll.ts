/**
 * Tokenless longpoll consumer for browser/widget/extension use cases.
 *
 * Carries no api_token. The category alone authorizes the subscription. The
 * user/server who derived the category is responsible for ensuring a
 * callback URL is set on their account (we can't preflight that without a
 * token).
 *
 * Behavior:
 * - HTTP non-2xx → terminal {@link AudDServerError} on the `errors` iterable
 *   (no silent infinite loop).
 * - JSON decode failure on 2xx → terminal {@link AudDSerializationError}.
 * - READ-class retries on 5xx + connection failures, configurable via
 *   `maxRetries` / `backoffFactorMs`.
 * - `[Symbol.asyncDispose]()` + manual `close()` for resource cleanup.
 *
 * Imported from `audd/longpoll` (browser-safe sub-entry, NOT the main
 * `audd` module — bundlers tree-shake the auth client out).
 */

import {
  AudDConnectionError,
} from "./errors.js";
import type { FetchLike, HttpResponse } from "./http.js";
import {
  startLongpoll,
  type LongpollPoll,
} from "./longpollCore.js";
import { defaultPolicy, retry, type RetryPolicy } from "./retry.js";
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
  sinceTime?: number;
  /** Server-side timeout in seconds (default 50). */
  timeout?: number;
}

/**
 * Tokenless longpoll consumer.
 *
 * ```ts
 * import { LongpollConsumer } from 'audd/longpoll';
 *
 * const consumer = new LongpollConsumer("abc123def");
 * const poll = consumer.iterate({ timeout: 30 });
 * for await (const m of poll.matches) {
 *   console.log(m.song.artist, m.song.title);
 * }
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
        headers: { "User-Agent": userAgent() },
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

    const fetchOnce = async (
      params: Record<string, string | undefined>,
      signal: AbortSignal,
    ): Promise<HttpResponse> => {
      try {
        return await retry(() => fetchOnceRaw(params, signal), policy);
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
    };

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
