import { describe, expect, it } from "vitest";
import type { HttpResponse } from "../src/http.js";
import { retry } from "../src/retry.js";

const ok = (status = 200): HttpResponse => ({
  jsonBody: { status: "success" },
  httpStatus: status,
  requestId: null,
  rawText: "",
});
const err = (status: number): HttpResponse => ({
  jsonBody: { status: "error" },
  httpStatus: status,
  requestId: null,
  rawText: "",
});

class TimeoutError extends Error {
  override readonly name = "AbortError";
}

function counter<T>(items: (T | Error)[]): {
  fn: () => Promise<T>;
  attempts: () => number;
} {
  let attempts = 0;
  return {
    attempts: () => attempts,
    fn: async () => {
      attempts++;
      const next = items.shift();
      if (next instanceof Error) throw next;
      if (next === undefined) throw new Error("exhausted");
      return next;
    },
  };
}

describe("retry policy", () => {
  it("read retries 503 then succeeds", async () => {
    const c = counter<HttpResponse>([err(503), err(503), ok()]);
    const r = await retry(c.fn, {
      retryClass: "read",
      maxAttempts: 3,
      backoffFactorMs: 0,
      backoffMaxMs: 0,
    });
    expect(r.httpStatus).toBe(200);
    expect(c.attempts()).toBe(3);
  });

  it("read gives up after maxAttempts and returns last response", async () => {
    const c = counter<HttpResponse>([err(503), err(503), err(503)]);
    const r = await retry(c.fn, {
      retryClass: "read",
      maxAttempts: 3,
      backoffFactorMs: 0,
      backoffMaxMs: 0,
    });
    expect(r.httpStatus).toBe(503);
    expect(c.attempts()).toBe(3);
  });

  it("read retries 408 and 429", async () => {
    const c1 = counter<HttpResponse>([err(408), ok()]);
    const r1 = await retry(c1.fn, {
      retryClass: "read",
      maxAttempts: 3,
      backoffFactorMs: 0,
      backoffMaxMs: 0,
    });
    expect(r1.httpStatus).toBe(200);

    const c2 = counter<HttpResponse>([err(429), ok()]);
    const r2 = await retry(c2.fn, {
      retryClass: "read",
      maxAttempts: 3,
      backoffFactorMs: 0,
      backoffMaxMs: 0,
    });
    expect(r2.httpStatus).toBe(200);
  });

  it("mutating does NOT retry 5xx (side effect may have happened)", async () => {
    const c = counter<HttpResponse>([err(503), ok()]);
    const r = await retry(c.fn, {
      retryClass: "mutating",
      maxAttempts: 3,
      backoffFactorMs: 0,
      backoffMaxMs: 0,
    });
    expect(r.httpStatus).toBe(503);
    expect(c.attempts()).toBe(1);
  });

  it("mutating retries pre-upload TypeError (network)", async () => {
    const c = counter<HttpResponse>([new TypeError("fetch failed"), ok()]);
    const r = await retry(c.fn, {
      retryClass: "mutating",
      maxAttempts: 3,
      backoffFactorMs: 0,
      backoffMaxMs: 0,
    });
    expect(r.httpStatus).toBe(200);
    expect(c.attempts()).toBe(2);
  });

  it("recognition does NOT retry post-upload AbortError (cost protection)", async () => {
    const c = counter<HttpResponse>([new TimeoutError("timeout"), ok()]);
    await expect(
      retry(c.fn, {
        retryClass: "recognition",
        maxAttempts: 3,
        backoffFactorMs: 0,
        backoffMaxMs: 0,
      }),
    ).rejects.toThrow();
    expect(c.attempts()).toBe(1);
  });

  it("recognition retries 5xx", async () => {
    const c = counter<HttpResponse>([err(502), ok()]);
    const r = await retry(c.fn, {
      retryClass: "recognition",
      maxAttempts: 3,
      backoffFactorMs: 0,
      backoffMaxMs: 0,
    });
    expect(r.httpStatus).toBe(200);
    expect(c.attempts()).toBe(2);
  });

  it("recognition retries pre-upload network error", async () => {
    const c = counter<HttpResponse>([new TypeError("fetch failed"), ok()]);
    const r = await retry(c.fn, {
      retryClass: "recognition",
      maxAttempts: 3,
      backoffFactorMs: 0,
      backoffMaxMs: 0,
    });
    expect(r.httpStatus).toBe(200);
    expect(c.attempts()).toBe(2);
  });

  it("does not retry non-retryable status (4xx)", async () => {
    const c = counter<HttpResponse>([err(400), ok()]);
    const r = await retry(c.fn, {
      retryClass: "read",
      maxAttempts: 3,
      backoffFactorMs: 0,
      backoffMaxMs: 0,
    });
    expect(r.httpStatus).toBe(400);
    expect(c.attempts()).toBe(1);
  });

  it("returns first 200 immediately", async () => {
    const c = counter<HttpResponse>([ok()]);
    const r = await retry(c.fn, {
      retryClass: "read",
      maxAttempts: 3,
      backoffFactorMs: 0,
      backoffMaxMs: 0,
    });
    expect(r.httpStatus).toBe(200);
    expect(c.attempts()).toBe(1);
  });
});
