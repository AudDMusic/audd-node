import { afterEach, describe, expect, it, vi } from "vitest";

import { AudD } from "../src/client.js";
import { deriveLongpollCategory } from "../src/helpers.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("setApiToken", () => {
  it("rotates the token used for subsequent requests", async () => {
    const captured: string[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const req = new Request(input, init);
      const body = await req.formData();
      const tok = body.get("api_token");
      if (typeof tok === "string") captured.push(tok);
      return new Response(JSON.stringify({ status: "success", result: null }), {
        headers: { "content-type": "application/json" },
      });
    });
    const audd = new AudD({ apiToken: "t-old", fetch: fetchMock as typeof fetch });
    await audd.recognize("https://example.mp3");
    audd.setApiToken("t-new");
    await audd.recognize("https://example.mp3");
    expect(captured).toEqual(["t-old", "t-new"]);
  });

  it("rejects empty token", () => {
    const audd = new AudD({ apiToken: "t" });
    expect(() => audd.setApiToken("")).toThrow();
  });

  it("reaches the streams namespace — deriveLongpollCategory uses the new token", () => {
    const audd = new AudD({ apiToken: "t-old" });
    const streams = audd.streams; // instantiate BEFORE rotation
    expect(streams.deriveLongpollCategory(42)).toBe(deriveLongpollCategory("t-old", 42));

    audd.setApiToken("t-new");
    expect(streams.deriveLongpollCategory(42)).toBe(deriveLongpollCategory("t-new", 42));
    expect(audd.streams.deriveLongpollCategory(42)).toBe(
      deriveLongpollCategory("t-new", 42),
    );
  });
});
