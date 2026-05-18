/**
 * Shared longpoll loop + handle, used by both the authenticated `Streams`
 * namespace (token in URL via `HttpClient.get`) and the tokenless
 * `LongpollConsumer` exported from `audd/longpoll`.
 *
 * Browser-safe: no node:crypto, no node:fs, no node:http imports. The whole
 * file relies on `fetch`-style I/O the caller injects.
 */

import {
  AudDConnectionError,
  AudDSerializationError,
  AudDServerError,
} from "./errors.js";
import type { HttpResponse } from "./http.js";
import type {
  StreamCallbackMatch,
  StreamCallbackNotification,
} from "./models.js";
import {
  parseStreamCallbackMatch,
  parseStreamCallbackNotification,
} from "./models.js";

const HTTP_CLIENT_ERROR_FLOOR = 400;

/**
 * Active long-poll subscription. Two typed `AsyncIterable`s carry the
 * happy-path output and a third carries any terminal error.
 *
 * Consume `matches` and `notifications` independently or in parallel:
 *
 * ```ts
 * const poll = await audd.streams.longpoll(category);
 * for await (const m of poll.matches) {
 *   console.log(m.song.artist, m.song.title);
 * }
 * ```
 *
 * Concurrent consumption:
 *
 * ```ts
 * await Promise.all([
 *   (async () => { for await (const m of poll.matches) {} })(),
 *   (async () => { for await (const n of poll.notifications) {} })(),
 *   (async () => { for await (const e of poll.errors) console.error(e); })(),
 * ]);
 * ```
 *
 * `close()` (or the `await using` resource-management form) tears down the
 * background loop and closes all three iterables.
 */
export interface LongpollPoll {
  /** Recognition events. */
  readonly matches: AsyncIterable<StreamCallbackMatch>;
  /** Stream-lifecycle events ("stream stopped", "can't connect", ...). */
  readonly notifications: AsyncIterable<StreamCallbackNotification>;
  /**
   * Terminal errors. The poll keeps polling on transient HTTP/JSON failures
   * (subject to the retry policy); errors that surface here are the ones the
   * loop gives up on. Each fired error is followed by closure of all three
   * iterables.
   */
  readonly errors: AsyncIterable<Error>;
  /** Stop the background loop. Idempotent. */
  close(): void;
  /** `await using` support — calls `close()`. */
  [Symbol.asyncDispose](): Promise<void>;
}

/**
 * Caller-supplied bits the loop needs:
 * - `fetchOnce` — performs a single longpoll HTTP GET, with caller-managed
 *   auth (token in URL, Bearer header, etc.) and retry policy.
 * - `getInitialSince` — initial `since_time` to send (often `undefined`).
 * - `timeout` — server-side longpoll timeout in seconds.
 * - `category` — the longpoll category derived from `(token, radio_id)`.
 * - `signal` — aborts the in-flight HTTP when the poll is closed.
 */
export interface LongpollLoopConfig {
  category: string;
  timeout: number;
  sinceTime: number | undefined;
  fetchOnce: (
    params: Record<string, string | undefined>,
    signal: AbortSignal,
  ) => Promise<HttpResponse>;
}

/**
 * Internal: a single-consumer-friendly bounded queue used to demultiplex
 * the loop output onto separate AsyncIterables.
 */
class AsyncQueue<T> {
  private readonly items: T[] = [];
  private readonly waiters: ((v: IteratorResult<T>) => void)[] = [];
  private done = false;

  push(value: T): void {
    if (this.done) return;
    const w = this.waiters.shift();
    if (w !== undefined) {
      w({ value, done: false });
      return;
    }
    this.items.push(value);
  }

  finish(): void {
    if (this.done) return;
    this.done = true;
    while (this.waiters.length > 0) {
      const w = this.waiters.shift();
      if (w !== undefined) w({ value: undefined as never, done: true });
    }
  }

  next(): Promise<IteratorResult<T>> {
    const item = this.items.shift();
    if (item !== undefined) return Promise.resolve({ value: item, done: false });
    if (this.done) return Promise.resolve({ value: undefined as never, done: true });
    return new Promise((resolve) => {
      this.waiters.push(resolve);
    });
  }

  toIterable(): AsyncIterable<T> {
    const next = (): Promise<IteratorResult<T>> => this.next();
    return {
      [Symbol.asyncIterator](): AsyncIterator<T> {
        return { next };
      },
    };
  }
}

/**
 * Decode one longpoll HTTP response into a Match | Notification | null
 * (null = keep-alive `{timeout, timestamp}` or any non-event body — caller
 * keeps polling). Throws on HTTP non-2xx and JSON-shape errors.
 */
function decodeOne(
  resp: HttpResponse,
): { kind: "match"; match: StreamCallbackMatch } | { kind: "notification"; notification: StreamCallbackNotification } | { kind: "keepalive" } {
  if (resp.httpStatus >= HTTP_CLIENT_ERROR_FLOOR) {
    throw new AudDServerError({
      errorCode: 0,
      message: `Longpoll endpoint returned HTTP ${String(resp.httpStatus)}`,
      httpStatus: resp.httpStatus,
      requestId: resp.requestId,
      rawResponse: resp.jsonBody ?? resp.rawText,
    });
  }
  const body = resp.jsonBody;
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new AudDSerializationError(
      "Longpoll response was not a JSON object",
      resp.rawText,
    );
  }
  const dict = body as Record<string, unknown>;
  if ("notification" in dict) {
    const notification = parseStreamCallbackNotification(dict.notification);
    const t = dict["time"];
    if (typeof t === "number") notification.time = t;
    return { kind: "notification", notification };
  }
  if ("result" in dict) {
    return { kind: "match", match: parseStreamCallbackMatch(dict.result) };
  }
  // Either a `{timeout, timestamp}` keep-alive or an empty/unknown body —
  // skip silently and keep polling.
  return { kind: "keepalive" };
}

/**
 * Start the longpoll loop on a background async task. Returns a
 * {@link LongpollPoll} handle whose iterables are filled as events arrive.
 * The caller's `fetchOnce` is responsible for retries and auth.
 */
export function startLongpoll(cfg: LongpollLoopConfig): LongpollPoll {
  const matches = new AsyncQueue<StreamCallbackMatch>();
  const notifications = new AsyncQueue<StreamCallbackNotification>();
  const errors = new AsyncQueue<Error>();

  const controller = new AbortController();
  let closed = false;

  const finishAll = (): void => {
    matches.finish();
    notifications.finish();
    errors.finish();
  };

  const close = (): void => {
    if (closed) return;
    closed = true;
    controller.abort();
    finishAll();
  };

  const run = async (): Promise<void> => {
    let curSince = cfg.sinceTime;
    while (!closed) {
      const params: Record<string, string | undefined> = {
        category: cfg.category,
        timeout: String(cfg.timeout),
      };
      if (curSince !== undefined) params["since_time"] = String(curSince);

      let resp: HttpResponse;
      try {
        resp = await cfg.fetchOnce(params, controller.signal);
      } catch (err) {
        if (closed) return;
        if (err instanceof TypeError) {
          errors.push(new AudDConnectionError(`Network error: ${err.message}`, err));
        } else if (
          err !== null &&
          typeof err === "object" &&
          (err as { name?: string }).name === "AbortError"
        ) {
          // Closed-from-outside path — drop quietly.
          if (closed) return;
          errors.push(new AudDConnectionError("Request was aborted (timeout)", err));
        } else if (err instanceof Error) {
          errors.push(err);
        } else {
          errors.push(new Error(String(err)));
        }
        finishAll();
        return;
      }

      try {
        const decoded = decodeOne(resp);
        if (decoded.kind === "match") matches.push(decoded.match);
        else if (decoded.kind === "notification") notifications.push(decoded.notification);
        // else keep-alive: skip.
      } catch (err) {
        errors.push(err instanceof Error ? err : new Error(String(err)));
        finishAll();
        return;
      }

      // Bump since_time off the response body's timestamp, as the audd-go
      // reference does — keeps reconnects from re-replaying old events.
      const dict = resp.jsonBody;
      if (typeof dict === "object" && dict !== null && !Array.isArray(dict)) {
        const ts = (dict as Record<string, unknown>)["timestamp"];
        if (typeof ts === "number") curSince = ts;
      }
    }
  };

  // Fire-and-forget. Failures land on the `errors` iterable.
  void run();

  return {
    matches: matches.toIterable(),
    notifications: notifications.toIterable(),
    errors: errors.toIterable(),
    close,
    async [Symbol.asyncDispose](): Promise<void> {
      close();
      await Promise.resolve();
    },
  };
}
