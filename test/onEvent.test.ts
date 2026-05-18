import { afterEach, describe, expect, it, vi } from "vitest";

import { AudD, type AudDEvent } from "../src/client.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("onEvent hook", () => {
  it("emits request then response on a successful recognize", async () => {
    const events: AudDEvent[] = [];
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ status: "success", result: null }), {
          headers: {
            "content-type": "application/json",
            "x-request-id": "rid-42",
          },
        }),
    );
    const audd = new AudD({
      apiToken: "t",
      fetch: fetchMock as typeof fetch,
      onEvent: (e) => events.push(e),
    });
    await audd.recognize("https://example.mp3");
    expect(events.map((e) => e.kind)).toEqual(["request", "response"]);
    expect(events[1]?.requestId).toBe("rid-42");
    expect(events[1]?.httpStatus).toBe(200);
    expect(events[1]?.elapsedMs).toBeTypeOf("number");
  });

  it("emits exception kind on connection failure", async () => {
    const events: AudDEvent[] = [];
    const fetchMock = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });
    const audd = new AudD({
      apiToken: "t",
      maxRetries: 1,
      fetch: fetchMock as typeof fetch,
      onEvent: (e) => events.push(e),
    });
    await expect(audd.recognize("https://example.mp3")).rejects.toThrow();
    expect(events.map((e) => e.kind)).toContain("exception");
  });

  it("hook exceptions are swallowed, never break the request path", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ status: "success", result: null }), {
          headers: { "content-type": "application/json" },
        }),
    );
    const audd = new AudD({
      apiToken: "t",
      fetch: fetchMock as typeof fetch,
      onEvent: () => {
        throw new Error("hook exploded");
      },
    });
    // Should not throw despite the hook throwing.
    await expect(audd.recognize("https://example.mp3")).resolves.toBeNull();
  });

  it("event never carries the api_token", async () => {
    const events: AudDEvent[] = [];
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ status: "success", result: null }), {
          headers: { "content-type": "application/json" },
        }),
    );
    const audd = new AudD({
      apiToken: "secret-token-do-not-leak",
      fetch: fetchMock as typeof fetch,
      onEvent: (e) => events.push(e),
    });
    await audd.recognize("https://example.mp3");
    for (const e of events) {
      expect(JSON.stringify(e)).not.toContain("secret-token-do-not-leak");
    }
  });
});
