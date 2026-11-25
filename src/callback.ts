/**
 * Callback-body parser. Browser-safe (no Node built-ins), so the tokenless
 * `@audd/sdk/longpoll` entry can share it with the main entry.
 */
import { AudDSerializationError } from "./errors.js";
import {
  parseStreamCallbackMatch,
  parseStreamCallbackNotification,
  type StreamCallbackMatch,
  type StreamCallbackNotification,
} from "./models.js";

/**
 * Result of {@link parseCallback} / {@link handleCallback}.
 *
 * Exactly one of `match` or `notification` is non-null on success.
 * Recognition callbacks populate `match`; lifecycle/error callbacks (e.g.
 * "stream stopped", "can't connect") populate `notification`.
 */
export interface ParsedCallback {
  match: StreamCallbackMatch | null;
  notification: StreamCallbackNotification | null;
}

/**
 * Parse a callback POST body into a typed match or notification.
 *
 * Accepts either a parsed JSON object or a string (serialized JSON). Throws
 * {@link AudDSerializationError} when the body is unparseable JSON, isn't an
 * object, or carries neither a `result` nor a `notification` block.
 *
 * Prefer {@link handleCallback} when you have a Node `http.IncomingMessage`,
 * a Web `Request`, or anything with a streamed body — that helper reads the
 * body for you.
 */
export function parseCallback(body: unknown): ParsedCallback {
  let raw: unknown = body;
  if (typeof body === "string") {
    try {
      raw = JSON.parse(body);
    } catch (err) {
      throw new AudDSerializationError(
        `callback body is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
        body,
      );
    }
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new AudDSerializationError(
      "callback body is not a JSON object",
      typeof body === "string" ? body : "",
    );
  }
  const r = raw as Record<string, unknown>;

  if ("notification" in r) {
    let notification: StreamCallbackNotification;
    try {
      notification = parseStreamCallbackNotification(r.notification);
    } catch (err) {
      throw new AudDSerializationError(
        `callback notification: ${err instanceof Error ? err.message : String(err)}`,
        typeof body === "string" ? body : JSON.stringify(r),
      );
    }
    const t = r.time;
    if (typeof t === "number") notification.time = t;
    return { match: null, notification };
  }

  if ("result" in r) {
    let match: StreamCallbackMatch;
    try {
      match = parseStreamCallbackMatch(r.result);
    } catch (err) {
      throw new AudDSerializationError(
        `callback result: ${err instanceof Error ? err.message : String(err)}`,
        typeof body === "string" ? body : JSON.stringify(r),
      );
    }
    return { match, notification: null };
  }

  throw new AudDSerializationError(
    "callback body has neither result nor notification",
    typeof body === "string" ? body : JSON.stringify(r),
  );
}
