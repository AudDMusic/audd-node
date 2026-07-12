import { afterEach, describe, expect, it, vi } from "vitest";

import { AudD } from "../src/client.js";
import { AudDConnectionError } from "../src/errors.js";

afterEach(() => {
  vi.restoreAllMocks();
});

/** Fetch mock that hangs until its signal aborts, then rejects like undici. */
function hangingFetch(): ReturnType<typeof vi.fn> {
  return vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
    return new Promise<Response>((_, reject) => {
      init?.signal?.addEventListener("abort", () => {
        const err = new Error("aborted");
        err.name = "AbortError";
        reject(err);
      });
    });
  });
}

describe("AbortSignal cancellation", () => {
  it("aborts the request when the user-supplied signal fires", async () => {
    const fetchMock = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      // Wait for abort and reject.
      return new Promise<Response>((_, reject) => {
        const signal = init?.signal;
        if (signal !== null && signal !== undefined) {
          signal.addEventListener("abort", () => {
            const err = new Error("aborted");
            err.name = "AbortError";
            reject(err);
          });
        }
      });
    });
    const audd = new AudD({
      apiToken: "t",
      maxRetries: 1,
      fetch: fetchMock as typeof fetch,
    });
    const controller = new AbortController();
    const p = audd.recognize("https://example.mp3", { signal: controller.signal });
    setTimeout(() => controller.abort(), 10);
    await expect(p).rejects.toThrow();
  });

  it("caller cancellation is surfaced as such — not as a timeout", async () => {
    const audd = new AudD({ apiToken: "t", fetch: hangingFetch() as unknown as typeof fetch });
    const controller = new AbortController();
    const p = audd.recognize("https://example.mp3", { signal: controller.signal });
    setTimeout(() => controller.abort(), 10);
    await expect(p).rejects.toThrow(AudDConnectionError);
    await expect(p).rejects.toThrow(/cancelled by the caller/);
    await expect(p).rejects.not.toThrow(/timeout/);
  });

  it("caller cancellation is never retried", async () => {
    const fetchMock = hangingFetch();
    const audd = new AudD({
      apiToken: "t",
      maxRetries: 3,
      backoffFactorMs: 1,
      fetch: fetchMock as unknown as typeof fetch,
    });
    const controller = new AbortController();
    const p = audd.recognize("https://example.mp3", { signal: controller.signal });
    setTimeout(() => controller.abort(), 10);
    await expect(p).rejects.toThrow(/cancelled by the caller/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("the SDK's own timeout is still reported as a timeout", async () => {
    const audd = new AudD({ apiToken: "t", fetch: hangingFetch() as unknown as typeof fetch });
    await expect(
      audd.recognize("https://example.mp3", { timeoutMs: 10 }),
    ).rejects.toThrow(/timeout/);
  });
});
