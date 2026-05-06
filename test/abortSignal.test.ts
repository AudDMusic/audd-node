import { afterEach, describe, expect, it, vi } from "vitest";

import { AudD } from "../src/client.js";

afterEach(() => {
  vi.restoreAllMocks();
});

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
});
