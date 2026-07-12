/**
 * The longpoll HTTP timeout must outlast the server-side poll window:
 * `longpoll({ timeout: 120 })` holds the connection ~120s, so the transport
 * timeout is (timeout + margin) seconds — not the fixed 60s standard timeout.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { AudD } from "../src/client.js";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("longpoll HTTP timeout", () => {
  it("scales with the requested poll timeout instead of dying at 60s", async () => {
    vi.useFakeTimers();
    let abortCount = 0;
    const fetchMock = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      return new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener("abort", () => {
          abortCount += 1;
          const err = new Error("aborted");
          err.name = "AbortError";
          reject(err);
        });
      });
    });
    const audd = new AudD({ apiToken: "t", fetch: fetchMock as typeof fetch });
    const poll = await audd.streams.longpoll("abc123def", {
      timeout: 120,
      skipCallbackCheck: true,
    });
    try {
      // Past the old fixed 60s ceiling — the poll must still be alive.
      await vi.advanceTimersByTimeAsync(61_000);
      expect(abortCount).toBe(0);
      // Past timeout + margin (130s) — now the transport timeout fires.
      await vi.advanceTimersByTimeAsync(70_000);
      expect(abortCount).toBe(1);
    } finally {
      poll.close();
    }
  });
});
