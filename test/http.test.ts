import { afterEach, describe, expect, it, vi } from "vitest";
import { HttpClient } from "../src/http.js";

afterEach(() => {
  vi.restoreAllMocks();
});

function mockFetch(
  handler: (req: Request) => Response | Promise<Response>,
): typeof globalThis.fetch {
  const fn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init);
    return handler(req);
  });
  return fn as unknown as typeof globalThis.fetch;
}

describe("HttpClient", () => {
  it("postForm sends api_token in body", async () => {
    const fetchImpl = mockFetch(async (req) => {
      const body = await req.formData();
      expect(body.get("api_token")).toBe("t-test");
      expect(body.get("url")).toBe("https://example.mp3");
      return new Response(JSON.stringify({ status: "success" }), {
        headers: { "content-type": "application/json" },
      });
    });
    const client = new HttpClient({ apiToken: "t-test", fetch: fetchImpl });
    const r = await client.postForm("https://api.audd.io/", { url: "https://example.mp3" });
    expect(r.jsonBody).toEqual({ status: "success" });
    expect(r.httpStatus).toBe(200);
  });

  it("postForm omits undefined fields", async () => {
    const fetchImpl = mockFetch(async (req) => {
      const body = await req.formData();
      expect(body.has("api_token")).toBe(true);
      expect(body.has("foo")).toBe(false);
      return new Response("{}");
    });
    const client = new HttpClient({ apiToken: "t", fetch: fetchImpl });
    await client.postForm("https://x/", { foo: undefined, bar: "baz" });
  });

  it("surfaces x-request-id header", async () => {
    const fetchImpl = mockFetch(
      () => new Response("{}", { headers: { "x-request-id": "rid-1" } }),
    );
    const r = await new HttpClient({ apiToken: "t", fetch: fetchImpl }).postForm(
      "https://x/",
      {},
    );
    expect(r.requestId).toBe("rid-1");
  });

  it("requestId is null when header missing", async () => {
    const fetchImpl = mockFetch(() => new Response("{}"));
    const r = await new HttpClient({ apiToken: "t", fetch: fetchImpl }).postForm(
      "https://x/",
      {},
    );
    expect(r.requestId).toBeNull();
  });

  it("sets User-Agent", async () => {
    let captured = "";
    const fetchImpl = mockFetch((req) => {
      captured = req.headers.get("user-agent") ?? "";
      return new Response("{}");
    });
    await new HttpClient({ apiToken: "t", fetch: fetchImpl }).postForm("https://x/", {});
    expect(captured).toMatch(/^audd-node\//);
  });

  it("get adds api_token query param", async () => {
    let capturedUrl = "";
    const fetchImpl = mockFetch((req) => {
      capturedUrl = req.url;
      return new Response('{"timeout":"no events"}');
    });
    await new HttpClient({ apiToken: "tk-1", fetch: fetchImpl }).get(
      "https://api.audd.io/longpoll/",
      { category: "abc", timeout: "30" },
    );
    expect(capturedUrl).toContain("api_token=tk-1");
    expect(capturedUrl).toContain("category=abc");
    expect(capturedUrl).toContain("timeout=30");
  });

  it("get does not overwrite api_token if URL already has it", async () => {
    let capturedUrl = "";
    const fetchImpl = mockFetch((req) => {
      capturedUrl = req.url;
      return new Response("{}");
    });
    await new HttpClient({ apiToken: "tk-default", fetch: fetchImpl }).get(
      "https://api.audd.io/longpoll/?api_token=tk-override",
      {},
    );
    expect(capturedUrl).toContain("api_token=tk-override");
    expect(capturedUrl).not.toContain("api_token=tk-default");
  });

  it("returns null jsonBody on non-JSON response", async () => {
    const fetchImpl = mockFetch(
      () => new Response("<html>oops</html>", { status: 502 }),
    );
    const r = await new HttpClient({ apiToken: "t", fetch: fetchImpl }).postForm(
      "https://x/",
      {},
    );
    expect(r.jsonBody).toBeNull();
    expect(r.httpStatus).toBe(502);
    expect(r.rawText).toContain("html");
  });
});
