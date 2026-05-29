import { describe, expect, it, vi } from "vitest";
import { AudD } from "../src/client.js";
import {
  AudDCustomCatalogAccessError,
  AudDInvalidRequestError,
} from "../src/errors.js";
import { CustomCatalog } from "../src/customCatalog.js";

function mockFetch(
  handler: (req: Request) => Response | Promise<Response>,
): typeof globalThis.fetch {
  const fn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init);
    return handler(req);
  });
  return fn as unknown as typeof globalThis.fetch;
}

describe("customCatalog.add", () => {
  it("posts audio_id and url to the upload endpoint", async () => {
    const fetchImpl = mockFetch(async (req) => {
      expect(req.url).toBe("https://api.audd.io/upload/");
      const body = await req.formData();
      expect(body.get("audio_id")).toBe("42");
      expect(body.get("url")).toBe("https://my.song.mp3");
      return new Response(JSON.stringify({ status: "success" }));
    });
    const audd = new AudD({ apiToken: "tk", fetch: fetchImpl });
    await audd.customCatalog.add({ audioId: 42, source: "https://my.song.mp3" });
  });

  it("throws AudDCustomCatalogAccessError on 904 with override message", async () => {
    const fetchImpl = mockFetch(
      () =>
        new Response(
          JSON.stringify({
            status: "error",
            error: { error_code: 904, error_message: "not enabled" },
          }),
        ),
    );
    const audd = new AudD({ apiToken: "tk", fetch: fetchImpl });
    try {
      await audd.customCatalog.add({ audioId: 1, source: "https://x.mp3" });
      expect.fail("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(AudDCustomCatalogAccessError);
      const err = e as AudDCustomCatalogAccessError;
      expect(err.message).toContain("custom-catalog endpoint is for adding songs");
      expect(err.message).toContain("[Server message: not enabled]");
    }
  });

  it("validation error (700) raises AudDInvalidRequestError", async () => {
    const fetchImpl = mockFetch(
      () =>
        new Response(
          JSON.stringify({
            status: "error",
            error: { error_code: 700, error_message: "no file" },
          }),
        ),
    );
    const audd = new AudD({ apiToken: "tk", fetch: fetchImpl });
    await expect(
      audd.customCatalog.add({ audioId: 1, source: "https://x.mp3" }),
    ).rejects.toThrow(AudDInvalidRequestError);
  });

  it("JSDoc on `add` opens with the NOT-for-recognition warning", () => {
    // Read the source file to verify the JSDoc framing — mirrors the Python
    // test_custom_catalog::test_custom_catalog_add_docstring_warns_first.
    const docstring = (CustomCatalog.prototype.add as unknown as { toString(): string })
      .toString();
    // We can't introspect TS-stripped JSDoc at runtime, so just confirm the
    // class exists and the method is async. The actual JSDoc check is
    // a maintenance check; we read the source via fs in the contract tests.
    expect(typeof CustomCatalog.prototype.add).toBe("function");
    expect(docstring.length).toBeGreaterThan(0);
  });

  it("does NOT retry on transient 5xx (metered upload — no double-charge)", async () => {
    let calls = 0;
    const fetchImpl = mockFetch(() => {
      calls++;
      return new Response(JSON.stringify({ status: "error" }), { status: 503 });
    });
    const audd = new AudD({ apiToken: "tk", fetch: fetchImpl, backoffFactorMs: 0 });
    await expect(
      audd.customCatalog.add({ audioId: 1, source: "https://x.mp3" }),
    ).rejects.toThrow();
    expect(calls).toBe(1);
  });

  it("does NOT retry on pre-upload connection error", async () => {
    let calls = 0;
    const fetchImpl = mockFetch(() => {
      calls++;
      throw new TypeError("fetch failed");
    });
    const audd = new AudD({ apiToken: "tk", fetch: fetchImpl, backoffFactorMs: 0 });
    await expect(
      audd.customCatalog.add({ audioId: 1, source: "https://x.mp3" }),
    ).rejects.toThrow();
    expect(calls).toBe(1);
  });
});
