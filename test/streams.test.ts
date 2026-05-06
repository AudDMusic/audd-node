import { describe, expect, it, vi } from "vitest";
import { AudD } from "../src/client.js";
import { AudDInvalidRequestError, AudDSerializationError } from "../src/errors.js";
import { DuplicateReturnParameterError } from "../src/helpers.js";

function makeFetch(handlers: ((req: Request) => Response | Promise<Response>)[]) {
  let i = 0;
  const fn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init);
    const handler = handlers[i++];
    if (!handler) throw new Error(`unexpected request #${i} to ${req.url}`);
    return handler(req);
  });
  return fn as unknown as typeof globalThis.fetch;
}

describe("streams.setCallbackUrl", () => {
  it("posts URL to setCallbackUrl", async () => {
    let captured = "";
    const fetchImpl = makeFetch([
      async (req) => {
        const body = await req.formData();
        captured = String(body.get("url"));
        return new Response(JSON.stringify({ status: "success", result: null }));
      },
    ]);
    const audd = new AudD({ apiToken: "tk", fetch: fetchImpl });
    await audd.streams.setCallbackUrl("https://my.host/cb");
    expect(captured).toBe("https://my.host/cb");
  });

  it("appends ?return= when returnMetadata passed", async () => {
    let captured = "";
    const fetchImpl = makeFetch([
      async (req) => {
        const body = await req.formData();
        captured = String(body.get("url"));
        return new Response(JSON.stringify({ status: "success", result: null }));
      },
    ]);
    const audd = new AudD({ apiToken: "tk", fetch: fetchImpl });
    await audd.streams.setCallbackUrl("https://my.host/cb", {
      returnMetadata: ["apple_music", "spotify"],
    });
    expect(captured).toContain("return=apple_music%2Cspotify");
  });

  it("raises DuplicateReturnParameterError when URL already has return", async () => {
    const audd = new AudD({ apiToken: "tk" });
    await expect(
      audd.streams.setCallbackUrl("https://my.host/cb?return=spotify", {
        returnMetadata: "apple_music",
      }),
    ).rejects.toThrow(DuplicateReturnParameterError);
  });
});

describe("streams.add / setUrl / delete / list", () => {
  it("add posts url and radio_id", async () => {
    let body: FormData | undefined;
    const fetchImpl = makeFetch([
      async (req) => {
        body = await req.formData();
        return new Response(JSON.stringify({ status: "success", result: null }));
      },
    ]);
    const audd = new AudD({ apiToken: "tk", fetch: fetchImpl });
    await audd.streams.add({
      url: "twitch:somechannel",
      radioId: 7,
      callbacks: "before",
    });
    expect(body?.get("url")).toBe("twitch:somechannel");
    expect(body?.get("radio_id")).toBe("7");
    expect(body?.get("callbacks")).toBe("before");
  });

  it("list parses Stream entries", async () => {
    const fetchImpl = makeFetch([
      () =>
        new Response(
          JSON.stringify({
            status: "success",
            result: [
              {
                radio_id: 7,
                url: "https://example/stream",
                stream_running: true,
                longpoll_category: "abc",
              },
            ],
          }),
        ),
    ]);
    const audd = new AudD({ apiToken: "tk", fetch: fetchImpl });
    const list = await audd.streams.list();
    expect(list).toHaveLength(1);
    expect(list[0]?.radioId).toBe(7);
  });

  it("list returns empty array on empty result", async () => {
    const fetchImpl = makeFetch([
      () => new Response(JSON.stringify({ status: "success", result: [] })),
    ]);
    const audd = new AudD({ apiToken: "tk", fetch: fetchImpl });
    expect(await audd.streams.list()).toEqual([]);
  });
});

describe("streams.deriveLongpollCategory", () => {
  it("matches the locked vector", () => {
    const audd = new AudD({ apiToken: "d29ebb205488e3b414bcc0c50432463e" });
    expect(audd.streams.deriveLongpollCategory(1)).toBe("088719f57");
  });
});

describe("streams.longpoll preflight", () => {
  it("preflight failure (code 19) raises AudDInvalidRequestError with hint", async () => {
    const fetchImpl = makeFetch([
      // First request: getCallbackUrl preflight returns 19
      () =>
        new Response(
          JSON.stringify({
            status: "error",
            error: { error_code: 19, error_message: "Internal error" },
          }),
        ),
    ]);
    const audd = new AudD({ apiToken: "tk", fetch: fetchImpl });
    const it_ = audd.streams.longpoll("abc")[Symbol.asyncIterator]();
    await expect(it_.next()).rejects.toThrowError(/Longpoll won't deliver events/);
  });

  it("skipCallbackCheck=true bypasses preflight", async () => {
    let preflightCalls = 0;
    const fetchImpl = makeFetch([
      // Should be the longpoll request directly
      (req) => {
        if (req.url.includes("getCallbackUrl")) preflightCalls++;
        return new Response(
          JSON.stringify({ timeout: "no events before timeout", timestamp: 12345 }),
        );
      },
    ]);
    const audd = new AudD({ apiToken: "tk", fetch: fetchImpl });
    const iter = audd.streams.longpoll("abc", { skipCallbackCheck: true })[
      Symbol.asyncIterator
    ]();
    const r = await iter.next();
    expect(r.value).toMatchObject({ timeout: "no events before timeout" });
    expect(preflightCalls).toBe(0);
  });

  it("preflight runs once across multiple iterations", async () => {
    let preflightCalls = 0;
    const handlers: ((req: Request) => Response | Promise<Response>)[] = [
      // 1: preflight
      (req) => {
        if (req.url.includes("getCallbackUrl")) preflightCalls++;
        return new Response(
          JSON.stringify({ status: "success", result: "https://my.host/cb" }),
        );
      },
      // 2: first longpoll
      () =>
        new Response(JSON.stringify({ timeout: "x", timestamp: 1 })),
      // 3: second longpoll
      () =>
        new Response(JSON.stringify({ timeout: "y", timestamp: 2 })),
    ];
    const fetchImpl = makeFetch(handlers);
    const audd = new AudD({ apiToken: "tk", fetch: fetchImpl });
    const iter = audd.streams.longpoll("abc")[Symbol.asyncIterator]();
    await iter.next();
    await iter.next();
    expect(preflightCalls).toBe(1);
  });

  it("malformed longpoll JSON raises AudDSerializationError", async () => {
    const fetchImpl = makeFetch([
      // preflight pass
      () =>
        new Response(JSON.stringify({ status: "success", result: "https://x/cb" })),
      // longpoll: returns array instead of object
      () => new Response(JSON.stringify(["not", "an", "object"])),
    ]);
    const audd = new AudD({ apiToken: "tk", fetch: fetchImpl });
    const iter = audd.streams.longpoll("abc")[Symbol.asyncIterator]();
    await expect(iter.next()).rejects.toThrow(AudDSerializationError);
  });

  it("non-19 preflight error propagates as-is", async () => {
    const fetchImpl = makeFetch([
      () =>
        new Response(
          JSON.stringify({
            status: "error",
            error: { error_code: 900, error_message: "bad token" },
          }),
        ),
    ]);
    const audd = new AudD({ apiToken: "tk", fetch: fetchImpl });
    const iter = audd.streams.longpoll("abc")[Symbol.asyncIterator]();
    await expect(iter.next()).rejects.toThrow();
    // Specifically not a "Longpoll won't deliver" preflight-helper error.
    try {
      await audd.streams.longpoll("abc")[Symbol.asyncIterator]().next();
    } catch (e) {
      expect((e as Error).message).not.toContain("Longpoll won't deliver");
    }
  });
});

describe("streams.parseCallback", () => {
  it("parses a result-shaped payload", () => {
    const audd = new AudD({ apiToken: "tk" });
    const p = audd.streams.parseCallback({
      status: "success",
      result: {
        radio_id: 7,
        timestamp: "ts",
        play_length: 10,
        results: [{ artist: "x", title: "y", score: 50 }],
      },
    });
    expect(p.isResult).toBe(true);
    expect(p.result?.radioId).toBe(7);
  });

  it("does not silence AudDInvalidRequestError types", () => {
    const e = new AudDInvalidRequestError({ errorCode: 19, message: "x", httpStatus: 200 });
    expect(e.errorCode).toBe(19);
  });
});
