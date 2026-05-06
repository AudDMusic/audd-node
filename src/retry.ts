import type { HttpResponse } from "./http.js";

/**
 * Cost-aware retry classes.
 *
 * - READ        — idempotent reads (`streams.list`, `streams.getCallbackUrl`):
 *                 retry on 408/429/5xx + any connection error.
 * - RECOGNITION — `recognize`, `recognizeEnterprise`, `advanced.findLyrics`:
 *                 retry on pre-upload connection failures + 5xx.
 *                 DO NOT retry on read-timeout-after-upload (cost protection).
 * - MUTATING    — `streams.add`, `streams.delete`, etc., `customCatalog.add`:
 *                 retry only on pre-upload connection failures. DO NOT retry
 *                 5xx (the side effect may have happened).
 */
export type RetryClass = "read" | "recognition" | "mutating";

export interface RetryPolicy {
  retryClass: RetryClass;
  maxAttempts: number;
  backoffFactorMs: number;
  backoffMaxMs: number;
}

export const DEFAULT_BACKOFF_FACTOR_MS = 500;
export const DEFAULT_BACKOFF_MAX_MS = 30_000;
export const DEFAULT_MAX_ATTEMPTS = 3;

const HTTP_REQUEST_TIMEOUT = 408;
const HTTP_TOO_MANY_REQUESTS = 429;
const HTTP_SERVER_ERROR_FLOOR = 500;

export function defaultPolicy(retryClass: RetryClass): RetryPolicy {
  return {
    retryClass,
    maxAttempts: DEFAULT_MAX_ATTEMPTS,
    backoffFactorMs: DEFAULT_BACKOFF_FACTOR_MS,
    backoffMaxMs: DEFAULT_BACKOFF_MAX_MS,
  };
}

function backoffDelayMs(attempt: number, policy: RetryPolicy): number {
  const base = Math.min(policy.backoffFactorMs * 2 ** attempt, policy.backoffMaxMs);
  return base * (0.5 + Math.random());
}

/**
 * `fetch()` raises `TypeError("fetch failed")` when DNS/TCP/TLS failed before
 * the request body finished. AbortError (or DOMException/AbortError) means the
 * caller's AbortSignal fired — could be pre- or post-upload, treated as
 * post-upload conservatively for cost-protection.
 */
function isAbortError(err: unknown): boolean {
  if (err === null || typeof err !== "object") return false;
  const e = err as { name?: unknown };
  return e.name === "AbortError";
}

function isPreUploadConnectionError(err: unknown): boolean {
  if (isAbortError(err)) return false;
  // Node fetch wraps DNS/TCP/TLS errors as TypeError. Browsers do too.
  return err instanceof TypeError;
}

function shouldRetryResponse(resp: HttpResponse, retryClass: RetryClass): boolean {
  const s = resp.httpStatus;
  switch (retryClass) {
    case "read":
      return (
        s === HTTP_REQUEST_TIMEOUT ||
        s === HTTP_TOO_MANY_REQUESTS ||
        s >= HTTP_SERVER_ERROR_FLOOR
      );
    case "recognition":
      return s >= HTTP_SERVER_ERROR_FLOOR;
    case "mutating":
      return false;
  }
}

function shouldRetryError(err: unknown, retryClass: RetryClass): boolean {
  switch (retryClass) {
    case "read":
      // Pre-upload connection errors and post-upload read timeouts are both
      // safe-ish: idempotent reads can be retried freely.
      return isPreUploadConnectionError(err) || isAbortError(err);
    case "recognition":
      // Pre-upload only — explicitly NOT post-upload AbortError (cost protection).
      return isPreUploadConnectionError(err);
    case "mutating":
      // Pre-upload only — server-side side-effect may have happened.
      return isPreUploadConnectionError(err);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function retry<T extends HttpResponse>(
  fn: () => Promise<T>,
  policy: RetryPolicy,
): Promise<T> {
  let lastError: unknown;
  let lastResp: T | undefined;
  let haveResp = false;
  for (let attempt = 0; attempt < policy.maxAttempts; attempt++) {
    try {
      const resp = await fn();
      if (!shouldRetryResponse(resp, policy.retryClass)) return resp;
      lastResp = resp;
      haveResp = true;
      lastError = undefined;
    } catch (err) {
      if (!shouldRetryError(err, policy.retryClass)) throw err;
      lastError = err;
      haveResp = false;
      if (attempt + 1 >= policy.maxAttempts) throw err;
    }
    if (attempt + 1 >= policy.maxAttempts) break;
    await sleep(backoffDelayMs(attempt, policy));
  }
  if (haveResp && lastResp !== undefined) return lastResp;
  throw lastError;
}
