/**
 * Shared longpoll loop + handle, used by both the authenticated `Streams`
 * namespace and the tokenless `LongpollConsumer` exported from
 * `@audd/sdk/longpoll`. Neither sends the api_token: the category alone
 * authorizes a longpoll request.
 *
 * Browser-safe: no node:crypto, no node:fs, no node:http imports. The whole
 * file relies on `fetch`-style I/O the caller injects.
 */

import { parseCallback, type ParsedCallback } from "./callback.js";
import {
  AudDConnectionError,
  AudDInvalidRequestError,
  AudDServerError,
  networkErrorMessage,
  raiseFromErrorResponse,
  type ServerErrorBody,
} from "./errors.js";
import type { HttpResponse } from "./http.js";
import type {
  StreamCallbackMatch,
  StreamCallbackNotification,
} from "./models.js";
import {
  asObject,
  parseStreamCallbackMatch,
  parseStreamCallbackNotification,
} from "./models.js";

const HTTP_CLIENT_ERROR_FLOOR = 400;

/**
 * Wait before the next request after a response that brought nothing new:
 * 1 s, doubling while such responses continue, up to 30 s.
 */
const IDLE_BACKOFF_INITIAL_MS = 1_000;
const IDLE_BACKOFF_MAX_MS = 30_000;

/**
 * Active long-poll subscription. Two typed `AsyncIterable`s carry the
 * happy-path output and a third carries the error that stops the poll.
 *
 * Consume `matches` and `notifications` independently or in parallel:
 *
 * ```ts
 * const poll = await audd.streams.longpoll(category);
 * for await (const m of poll.matches) {
 *   console.log(m.song?.artist ?? "?", m.song?.title ?? "?");
 * }
 * // `matches` ends when the poll stops; if an error stopped it, `errors` has it.
 * for await (const err of poll.errors) throw err;
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
 * The loop sends the newest event's `timestamp` as `since_time` on the next
 * request (or, after a wait with no events, the server's timestamp), so each
 * event arrives once.
 *
 * `close()` (or the `await using` resource-management form) tears down the
 * background loop, aborts a request that is waiting, and closes all three
 * iterables.
 */
export interface LongpollPoll {
  /** Recognition events, in the order the server sent them. */
  readonly matches: AsyncIterable<StreamCallbackMatch>;
  /** Stream-lifecycle events ("stream stopped", "can't connect", ...). */
  readonly notifications: AsyncIterable<StreamCallbackNotification>;
  /**
   * The error that stops the poll, delivered once; all three iterables
   * complete after it. Network failures and HTTP 5xx are retried first, up
   * to the client's `maxRetries`. What stops the poll: an HTTP 4xx, a
   * failure that outlasts the retries, or the server rejecting the request
   * itself (for example a `timeout` outside 1–120), which arrives as an
   * {@link AudDInvalidRequestError} carrying the server's text. A response
   * the SDK can't read stops nothing: the next request waits 1 s, doubling
   * up to 30 s while such responses continue.
   */
  readonly errors: AsyncIterable<Error>;
  /** Stop the background loop. Idempotent. */
  close(): void;
  /** `await using` support — calls `close()`. */
  [Symbol.asyncDispose](): Promise<void>;
}

/**
 * Caller-supplied bits the loop needs:
 * - `category` — the 9-char longpoll category.
 * - `timeout` — server-side longpoll timeout in seconds (1–120).
 * - `sinceTime` — `since_time` for the first request (often `undefined`).
 * - `fetchOnce` — performs a single longpoll HTTP GET under the caller's
 *   retry policy; `signal` aborts it when the poll is closed.
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

/** One longpoll response, decoded. */
interface LongpollBatch {
  /** Callback payloads to deliver, in server order. */
  events: ParsedCallback[];
  /** `since_time` for the next request, when the response carried one. */
  sinceTime: number | undefined;
}

const NOTHING: LongpollBatch = { events: [], sinceTime: undefined };

/** A server timestamp in ms: an integer, or a string of digits. */
function asTimestamp(v: unknown): number | undefined {
  if (typeof v === "number") return Number.isFinite(v) ? Math.trunc(v) : undefined;
  if (typeof v === "string" && /^\s*\d+\s*$/.test(v)) return Number(v.trim());
  return undefined;
}

/**
 * The server rejected the request itself; sending it again gets the same
 * answer. `{"error": "<text>"}` becomes {@link AudDInvalidRequestError}
 * carrying the text; an AudD-style `{"status": "error", "error": {...}}`
 * becomes the typed error for its code.
 */
function throwIfErrorBody(body: Record<string, unknown>, resp: HttpResponse): void {
  const error = body["error"];
  if (typeof error === "string") {
    throw new AudDInvalidRequestError({
      errorCode: 0,
      message: error !== "" ? error : "Longpoll request rejected",
      httpStatus: resp.httpStatus,
      requestId: resp.requestId,
      rawResponse: body,
    });
  }
  if (body["status"] === "error" || asObject(error) !== undefined) {
    raiseFromErrorResponse(body as ServerErrorBody, {
      httpStatus: resp.httpStatus,
      requestId: resp.requestId,
    });
  }
}

/**
 * One event's `data`: the body a callback URL receives, as an object or a
 * JSON string. `undefined` when it can't be read or has nothing to deliver
 * (an empty `results` list, a `notification` that isn't an object).
 */
function parseEventData(data: unknown): ParsedCallback | undefined {
  let parsed: ParsedCallback;
  try {
    parsed = parseCallback(data);
  } catch {
    return undefined;
  }
  if (parsed.match !== null && parsed.match.song === undefined) return undefined;
  if (parsed.notification !== null && Object.keys(parsed.notification.rawResponse).length === 0) {
    return undefined;
  }
  return parsed;
}

/**
 * Decode one longpoll response. The server answers HTTP 200 with one of:
 *
 * - `{"events": [{"timestamp", "category", "data"}, ...]}`, where each
 *   `data` is the body a callback URL receives (a recognition `result` or a
 *   `notification`);
 * - `{"timeout": "...", "timestamp"}` when nothing happened during the wait;
 * - `{"error": "..."}` when the request itself is invalid.
 *
 * A body with `result` or `notification` at the top level (and an optional
 * `timestamp`) reads as a single event.
 *
 * Throws for HTTP 4xx/5xx and error bodies. Anything else it can't read (an
 * empty, non-JSON or unknown body, an event it can't parse) yields nothing.
 */
function decodeLongpollResponse(resp: HttpResponse): LongpollBatch {
  if (resp.httpStatus >= HTTP_CLIENT_ERROR_FLOOR) {
    throw new AudDServerError({
      errorCode: 0,
      message: `Longpoll endpoint returned HTTP ${String(resp.httpStatus)}`,
      httpStatus: resp.httpStatus,
      requestId: resp.requestId,
      rawResponse: resp.jsonBody ?? resp.rawText,
    });
  }
  const body = asObject(resp.jsonBody);
  if (body === undefined) return NOTHING;
  throwIfErrorBody(body, resp);

  const rawEvents = body["events"];
  if (Array.isArray(rawEvents)) {
    const events: ParsedCallback[] = [];
    let newest: number | undefined;
    for (const item of rawEvents) {
      const event = asObject(item);
      if (event === undefined) continue;
      const ts = asTimestamp(event["timestamp"]);
      if (ts !== undefined && (newest === undefined || ts > newest)) newest = ts;
      const parsed = parseEventData(event["data"]);
      if (parsed !== undefined) events.push(parsed);
    }
    return { events, sinceTime: newest };
  }

  const sinceTime = asTimestamp(body["timestamp"]);
  if (asObject(body["notification"]) !== undefined) {
    const notification = parseStreamCallbackNotification(body["notification"]);
    const t = body["time"];
    if (typeof t === "number") notification.time = t;
    return { events: [{ match: null, notification }], sinceTime };
  }
  if (asObject(body["result"]) !== undefined) {
    return {
      events: [{ match: parseStreamCallbackMatch(body["result"]), notification: null }],
      sinceTime,
    };
  }
  // `{timeout, timestamp}`, or a shape this SDK doesn't know.
  return { events: [], sinceTime };
}

function isAbortError(err: unknown): boolean {
  return (
    err !== null &&
    typeof err === "object" &&
    (err as { name?: unknown }).name === "AbortError"
  );
}

/** Map a failed `fetchOnce` onto the error the poll stops with. */
function transportError(err: unknown): Error {
  if (err instanceof TypeError) return new AudDConnectionError(networkErrorMessage(err), err);
  if (isAbortError(err)) return new AudDConnectionError("Request was aborted (timeout)", err);
  return err instanceof Error ? err : new Error(String(err));
}

/** Resolve after `ms`, or as soon as `signal` aborts. */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const done = (): void => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
  });
}

/**
 * Start the longpoll loop on a background async task. Returns a
 * {@link LongpollPoll} handle whose iterables are filled as events arrive.
 * The caller's `fetchOnce` is responsible for retries.
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

  /** Deliver the error that stops the poll, once, then complete everything. */
  const stop = (err: unknown): void => {
    if (!closed) errors.push(err instanceof Error ? err : new Error(String(err)));
    finishAll();
  };

  const run = async (): Promise<void> => {
    let curSince = cfg.sinceTime;
    let idleDelayMs = 0;
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
        // A request aborted by close() ends the loop quietly.
        if (closed) return;
        stop(transportError(err));
        return;
      }
      if (closed) return;

      let batch: LongpollBatch;
      try {
        batch = decodeLongpollResponse(resp);
      } catch (err) {
        stop(err);
        return;
      }

      for (const event of batch.events) {
        if (event.match !== null) matches.push(event.match);
        else if (event.notification !== null) notifications.push(event.notification);
      }

      const next = batch.sinceTime;
      const advanced = next !== undefined && (curSince === undefined || next > curSince);
      if (next !== undefined) curSince = next;
      if (advanced) {
        idleDelayMs = 0;
        continue;
      }
      // Nothing moved the cursor (an empty or unreadable body, an empty
      // `events` list): asking again at once would get the same answer.
      idleDelayMs =
        idleDelayMs === 0
          ? IDLE_BACKOFF_INITIAL_MS
          : Math.min(idleDelayMs * 2, IDLE_BACKOFF_MAX_MS);
      await sleep(idleDelayMs, controller.signal);
    }
  };

  // Background task. Failures land on the `errors` iterable.
  run().catch((err: unknown) => {
    stop(err);
  });

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
