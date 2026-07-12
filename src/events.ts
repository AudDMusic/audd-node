/** Inspection events emitted around each HTTP request the SDK makes. */

import type { HttpResponse } from "./http.js";

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

export function safeEmit(hook: OnEventHook | undefined, event: AudDEvent): void {
  if (hook === undefined) return;
  try {
    hook(event);
  } catch {
    // Observability hooks must never break the request path.
  }
}

/**
 * Run `fn` and emit the `request` → `response` (or `exception`) lifecycle
 * events around it. Used by every namespace so `onEvent` sees the full
 * request surface, not just `recognize`.
 */
export async function emitAround<T extends HttpResponse>(
  hook: OnEventHook | undefined,
  method: string,
  url: string,
  fn: () => Promise<T>,
): Promise<T> {
  const startedAt = Date.now();
  safeEmit(hook, {
    kind: "request", method, url,
    requestId: null, httpStatus: null, elapsedMs: null, errorCode: null, extras: {},
  });
  let resp: T;
  try {
    resp = await fn();
  } catch (err) {
    safeEmit(hook, {
      kind: "exception", method, url,
      requestId: null, httpStatus: null,
      elapsedMs: Date.now() - startedAt, errorCode: null,
      extras: { name: err instanceof Error ? err.name : String(err) },
    });
    throw err;
  }
  safeEmit(hook, {
    kind: "response", method, url,
    requestId: resp.requestId, httpStatus: resp.httpStatus,
    elapsedMs: Date.now() - startedAt, errorCode: null, extras: {},
  });
  return resp;
}
