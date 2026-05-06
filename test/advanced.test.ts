import { describe, expect, it, vi } from "vitest";
import { AudD } from "../src/client.js";
import { AudDInvalidRequestError } from "../src/errors.js";

function mockFetch(
  handler: (req: Request) => Response | Promise<Response>,
): typeof globalThis.fetch {
  const fn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init);
    return handler(req);
  });
  return fn as unknown as typeof globalThis.fetch;
}

describe("advanced.findLyrics", () => {
  it("returns parsed LyricsResult list", async () => {
    const fetchImpl = mockFetch(async (req) => {
      expect(req.url).toBe("https://api.audd.io/findLyrics/");
      const body = await req.formData();
      expect(body.get("q")).toBe("rule the world");
      return new Response(
        JSON.stringify({
          status: "success",
          result: [
            {
              song_id: 99,
              artist: "Tears For Fears",
              title: "Everybody Wants To Rule The World",
              lyrics: "Welcome to your life...",
              full_title: "Tears For Fears - Everybody Wants To Rule The World",
            },
          ],
        }),
      );
    });
    const audd = new AudD({ apiToken: "tk", fetch: fetchImpl });
    const r = await audd.advanced.findLyrics("rule the world");
    expect(r).toHaveLength(1);
    expect(r[0]?.songId).toBe(99);
    expect(r[0]?.fullTitle).toContain("Tears For Fears");
  });

  it("returns empty list on null result", async () => {
    const fetchImpl = mockFetch(
      () => new Response(JSON.stringify({ status: "success", result: null })),
    );
    const audd = new AudD({ apiToken: "tk", fetch: fetchImpl });
    expect(await audd.advanced.findLyrics("xx")).toEqual([]);
  });

  it("error response raises typed exception", async () => {
    const fetchImpl = mockFetch(
      () =>
        new Response(
          JSON.stringify({
            status: "error",
            error: { error_code: 700, error_message: "no q" },
          }),
        ),
    );
    const audd = new AudD({ apiToken: "tk", fetch: fetchImpl });
    await expect(audd.advanced.findLyrics("")).rejects.toThrow(AudDInvalidRequestError);
  });
});

describe("advanced.rawRequest", () => {
  it("hits the named method endpoint and returns raw body dict", async () => {
    const fetchImpl = mockFetch(async (req) => {
      expect(req.url).toBe("https://api.audd.io/customMethod/");
      const body = await req.formData();
      expect(body.get("foo")).toBe("bar");
      return new Response(JSON.stringify({ status: "success", custom: 123 }));
    });
    const audd = new AudD({ apiToken: "tk", fetch: fetchImpl });
    const r = await audd.advanced.rawRequest("customMethod", { foo: "bar" });
    expect(r).toEqual({ status: "success", custom: 123 });
  });

  it("non-object response raises AudDSerializationError", async () => {
    const fetchImpl = mockFetch(() => new Response('"just a string"'));
    const audd = new AudD({ apiToken: "tk", fetch: fetchImpl });
    await expect(audd.advanced.rawRequest("foo")).rejects.toThrow();
  });
});
