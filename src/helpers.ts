import { createHash } from "node:crypto";
import { AudDInvalidRequestError, AudDSerializationError } from "./errors.js";
import {
  parseStreamCallbackMatch,
  parseStreamCallbackNotification,
  type StreamCallbackMatch,
  type StreamCallbackNotification,
} from "./models.js";

/**
 * Raised by `addReturnToUrl` (and therefore by `streams.setCallbackUrl`)
 * when the URL already contains a `return` query parameter and a
 * `returnMetadata` argument is also passed — conflicting intent.
 */
export class DuplicateReturnParameterError extends AudDInvalidRequestError {
  override name = "DuplicateReturnParameterError";
  constructor() {
    super({
      errorCode: 0,
      message:
        "URL already contains a `return` query parameter; pass returnMetadata: undefined " +
        "or remove the parameter from the URL — refusing to silently overwrite.",
      httpStatus: 0,
      requestId: null,
      requestedParams: {},
      requestMethod: null,
      brandedMessage: null,
      rawResponse: null,
    });
  }
}

/**
 * Compute the 9-char longpoll category locally from the API token + radio_id.
 *
 * Formula (per docs.audd.io/streams.md): hex-MD5 of (hex-MD5 of api_token,
 * concatenated with the radio_id rendered as a decimal string), truncated
 * to the first 9 hex chars.
 *
 * Pure function — no network call. Lets servers share a longpoll category
 * with browser/mobile clients without leaking the api_token.
 */
export function deriveLongpollCategory(apiToken: string, radioId: number): string {
  const inner = createHash("md5").update(apiToken, "utf8").digest("hex");
  const full = createHash("md5").update(inner + String(radioId), "utf8").digest("hex");
  return full.slice(0, 9);
}

/**
 * Append `?return=<metadata>` (or merge as `&return=`) to the callback URL.
 *
 * - If `returnMetadata` is `undefined`, returns the URL unchanged.
 * - If the URL already has a `return` query parameter, raises rather than
 *   silently overwriting.
 */
export function addReturnToUrl(
  url: string,
  returnMetadata: string | string[] | undefined,
): string {
  if (returnMetadata === undefined) return url;
  const value = Array.isArray(returnMetadata) ? returnMetadata.join(",") : returnMetadata;
  const u = new URL(url);
  if (u.searchParams.has("return")) {
    throw new DuplicateReturnParameterError();
  }
  u.searchParams.set("return", value);
  return u.toString();
}

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

/**
 * Minimum shape we accept from a "request-like" object: anything that exposes
 * a `body` (already-parsed-or-stringified JSON), or that is itself a stream we
 * can drain.
 *
 * Concretely supports:
 * - Node `http.IncomingMessage` (async-iterable of `Buffer | string`)
 * - Web `Request` / `fetch` `Body` (has `.text()`)
 * - Express/Fastify/Hono request (has a `.body` already populated by a JSON parser)
 * - Plain `{ body: <parsed-json | string> }` shapes
 */
type CallbackRequestLike =
  | { text(): Promise<string> }
  | { body?: unknown; [k: string]: unknown }
  | AsyncIterable<unknown>;

/**
 * Read and parse a callback POST body off a Node, Web, or framework-style
 * request. Picks the right strategy by duck-typing:
 *
 * 1. If the request exposes a `text()` method (Web `Request`, `fetch` body),
 *    awaits it and parses the resulting string.
 * 2. Otherwise, if the request has a `body` property that's already an object
 *    (Express/Fastify/Hono with a JSON middleware) or string, parses that
 *    directly without touching the underlying stream.
 * 3. Otherwise, treats the request as an async-iterable of chunks
 *    (`http.IncomingMessage`) and concatenates the body before parsing.
 *
 * Throws {@link AudDSerializationError} on any parse failure.
 */
export async function handleCallback(req: CallbackRequestLike): Promise<ParsedCallback> {
  // 1. Web Request / Response-like — has a text() method.
  if (typeof (req as { text?: unknown }).text === "function") {
    const text = await (req as { text: () => Promise<string> }).text();
    return parseCallback(text);
  }

  // 2. Framework request — body already populated.
  const reqRecord = req as { body?: unknown };
  if ("body" in reqRecord && reqRecord.body !== undefined && reqRecord.body !== null) {
    const body = reqRecord.body;
    // If body is itself a readable stream (e.g. raw express without
    // express.json()), fall through to the streaming path below.
    if (
      typeof body === "object" &&
      body !== null &&
      Symbol.asyncIterator in (body as object) &&
      // Plain Buffer/Uint8Array also has Symbol.iterator — accept those by value.
      !(body instanceof Uint8Array)
    ) {
      // Streamed body — drain it.
      return parseCallback(await drainAsyncIterable(body as AsyncIterable<unknown>));
    }
    if (body instanceof Uint8Array) {
      return parseCallback(new TextDecoder().decode(body));
    }
    return parseCallback(body);
  }

  // 3. The request is itself an async-iterable (http.IncomingMessage).
  if (typeof req === "object" && req !== null && Symbol.asyncIterator in req) {
    return parseCallback(await drainAsyncIterable(req as AsyncIterable<unknown>));
  }

  throw new AudDSerializationError(
    "handleCallback: request has no body, no text() method, and is not async-iterable",
  );
}

async function drainAsyncIterable(it: AsyncIterable<unknown>): Promise<string> {
  const chunks: Uint8Array[] = [];
  let stringBuf = "";
  for await (const chunk of it) {
    if (typeof chunk === "string") {
      stringBuf += chunk;
    } else if (chunk instanceof Uint8Array) {
      chunks.push(chunk);
    } else if (chunk !== null && chunk !== undefined) {
      // Best-effort fallback — Node's stream/consumers can yield Buffer-likes.
      stringBuf += String(chunk);
    }
  }
  if (chunks.length > 0) {
    let total = 0;
    for (const c of chunks) total += c.byteLength;
    const merged = new Uint8Array(total);
    let offset = 0;
    for (const c of chunks) {
      merged.set(c, offset);
      offset += c.byteLength;
    }
    stringBuf = new TextDecoder().decode(merged) + stringBuf;
  }
  return stringBuf;
}
