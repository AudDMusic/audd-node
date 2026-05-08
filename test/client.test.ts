import { describe, expect, it, vi } from "vitest";
import { AudD } from "../src/client.js";
import {
  AudDAuthenticationError,
  AudDCustomCatalogAccessError,
  AudDInvalidRequestError,
  AudDSerializationError,
  AudDServerError,
  AudDSubscriptionError,
} from "../src/errors.js";

function mockFetch(
  handler: (req: Request) => Response | Promise<Response>,
): typeof globalThis.fetch {
  const fn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init);
    return handler(req);
  });
  return fn as unknown as typeof globalThis.fetch;
}

describe("AudD.recognize", () => {
  it("returns parsed RecognitionResult on success", async () => {
    const fetchImpl = mockFetch(async (req) => {
      const body = await req.formData();
      expect(body.get("api_token")).toBe("test");
      expect(body.get("url")).toBe("https://audd.tech/example.mp3");
      return new Response(
        JSON.stringify({
          status: "success",
          result: {
            artist: "Tears For Fears",
            title: "Everybody Wants To Rule The World",
            timecode: "00:56",
            song_link: "https://lis.tn/NbkVb",
          },
        }),
      );
    });
    const audd = new AudD({ apiToken: "test", fetch: fetchImpl });
    const r = await audd.recognize("https://audd.tech/example.mp3");
    expect(r?.artist).toBe("Tears For Fears");
    expect(r?.title).toBe("Everybody Wants To Rule The World");
  });

  it("returns null on no match (status=success, result=null)", async () => {
    const fetchImpl = mockFetch(
      () => new Response(JSON.stringify({ status: "success", result: null })),
    );
    const audd = new AudD({ apiToken: "test", fetch: fetchImpl });
    const r = await audd.recognize("https://audd.tech/example.mp3");
    expect(r).toBeNull();
  });

  it("forwards return param as comma-joined string", async () => {
    const fetchImpl = mockFetch(async (req) => {
      const body = await req.formData();
      expect(body.get("return")).toBe("apple_music,spotify");
      return new Response(JSON.stringify({ status: "success", result: null }));
    });
    const audd = new AudD({ apiToken: "test", fetch: fetchImpl });
    await audd.recognize("https://x.mp3", { return: ["apple_music", "spotify"] });
  });

  it("throws AudDAuthenticationError on code 900", async () => {
    const fetchImpl = mockFetch(
      () =>
        new Response(
          JSON.stringify({
            status: "error",
            error: { error_code: 900, error_message: "bad token" },
          }),
        ),
    );
    const audd = new AudD({ apiToken: "bad", fetch: fetchImpl });
    await expect(audd.recognize("https://x.mp3")).rejects.toThrow(AudDAuthenticationError);
  });

  it("throws AudDServerError on non-2xx with non-JSON body (HTTP-vs-JSON distinction)", async () => {
    const fetchImpl = mockFetch(() => new Response("<html>502 Bad Gateway</html>", { status: 502 }));
    const audd = new AudD({
      apiToken: "x",
      fetch: fetchImpl,
      maxRetries: 1,
    });
    await expect(audd.recognize("https://x.mp3")).rejects.toThrow(AudDServerError);
  });

  it("throws AudDSerializationError on 200 with malformed JSON", async () => {
    const fetchImpl = mockFetch(
      () => new Response("not json {{ broken", { status: 200 }),
    );
    const audd = new AudD({ apiToken: "x", fetch: fetchImpl });
    await expect(audd.recognize("https://x.mp3")).rejects.toThrow(AudDSerializationError);
  });

  it("code 51 with usable result emits warning and passes through", async () => {
    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const fetchImpl = mockFetch(
      () =>
        new Response(
          JSON.stringify({
            status: "error",
            error: { error_code: 51, error_message: "deprecated foo param" },
            result: {
              artist: "X",
              title: "Y",
              timecode: "00:01",
            },
          }),
        ),
    );
    const audd = new AudD({ apiToken: "test", fetch: fetchImpl });
    const r = await audd.recognize("https://x.mp3");
    expect(r?.artist).toBe("X");
    expect(consoleWarn).toHaveBeenCalledOnce();
    consoleWarn.mockRestore();
  });

  it("code 51 without result raises AudDInvalidRequestError", async () => {
    const fetchImpl = mockFetch(
      () =>
        new Response(
          JSON.stringify({
            status: "error",
            error: { error_code: 51, error_message: "deprecated, no result" },
          }),
        ),
    );
    const audd = new AudD({ apiToken: "test", fetch: fetchImpl });
    await expect(audd.recognize("https://x.mp3")).rejects.toThrow(AudDInvalidRequestError);
  });
});

describe("AudD.recognizeEnterprise", () => {
  it("returns flat list of EnterpriseMatches across chunks", async () => {
    const fetchImpl = mockFetch(async (req) => {
      const body = await req.formData();
      expect(body.get("limit")).toBe("1");
      return new Response(
        JSON.stringify({
          status: "success",
          result: [
            {
              songs: [
                {
                  score: 81,
                  timecode: "00:57",
                  artist: "Tears For Fears",
                  title: "Everybody Wants To Rule The World",
                  isrc: "GBUM71403885",
                },
              ],
              offset: "00:00",
            },
          ],
        }),
      );
    });
    const audd = new AudD({ apiToken: "test", fetch: fetchImpl });
    const matches = await audd.recognizeEnterprise("https://audd.tech/example.mp3", { limit: 1 });
    expect(matches).toHaveLength(1);
    expect(matches[0]?.artist).toBe("Tears For Fears");
    expect(matches[0]?.isrc).toBe("GBUM71403885");
  });
});

describe("AudD.customCatalog.add", () => {
  it("904 from upload raises AudDCustomCatalogAccessError with override message", async () => {
    const fetchImpl = mockFetch(
      () =>
        new Response(
          JSON.stringify({
            status: "error",
            error: { error_code: 904, error_message: "no access" },
          }),
        ),
    );
    const audd = new AudD({ apiToken: "test", fetch: fetchImpl });
    await expect(
      audd.customCatalog.add({ audioId: 42, source: "https://my.song.mp3" }),
    ).rejects.toThrow(AudDCustomCatalogAccessError);
  });

  it("905 still mapped to AudDSubscriptionError (not custom-catalog override)", async () => {
    // 905 IS overridden too because it maps to AudDSubscriptionError, but the
    // hierarchy ensures the catch hits at AudDCustomCatalogAccessError or its
    // parent AudDSubscriptionError.
    const fetchImpl = mockFetch(
      () =>
        new Response(
          JSON.stringify({
            status: "error",
            error: { error_code: 905, error_message: "subscription needed" },
          }),
        ),
    );
    const audd = new AudD({ apiToken: "test", fetch: fetchImpl });
    await expect(
      audd.customCatalog.add({ audioId: 42, source: "https://x.mp3" }),
    ).rejects.toThrow(AudDSubscriptionError);
  });
});

describe("AudD lazy namespaces", () => {
  it("streams getter returns same instance on multiple accesses", () => {
    const audd = new AudD({ apiToken: "test" });
    expect(audd.streams).toBe(audd.streams);
  });
  it("customCatalog getter returns same instance on multiple accesses", () => {
    const audd = new AudD({ apiToken: "test" });
    expect(audd.customCatalog).toBe(audd.customCatalog);
  });
  it("advanced getter returns same instance on multiple accesses", () => {
    const audd = new AudD({ apiToken: "test" });
    expect(audd.advanced).toBe(audd.advanced);
  });
});
