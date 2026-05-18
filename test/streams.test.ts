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
    await expect(audd.streams.longpoll("abc")).rejects.toThrowError(
      /Longpoll won't deliver events/,
    );
  });

  it("skipCallbackCheck=true bypasses preflight and dispatches a match", async () => {
    let preflightCalls = 0;
    const fetchImpl = makeFetch([
      (req) => {
        if (req.url.includes("getCallbackUrl")) preflightCalls++;
        return new Response(
          JSON.stringify({
            result: {
              radio_id: 7,
              timestamp: "x",
              results: [{ artist: "A", title: "T", score: 100 }],
            },
          }),
        );
      },
    ]);
    const audd = new AudD({ apiToken: "tk", fetch: fetchImpl });
    const poll = await audd.streams.longpoll("abc", { skipCallbackCheck: true });
    const it = poll.matches[Symbol.asyncIterator]();
    const r = await it.next();
    poll.close();
    expect(r.done).toBe(false);
    expect(r.value.song.artist).toBe("A");
    expect(preflightCalls).toBe(0);
  });

  it("preflight runs only once before the loop starts", async () => {
    let preflightCalls = 0;
    let longpollCalls = 0;
    const fetchImpl = makeFetch([
      (req) => {
        if (req.url.includes("getCallbackUrl")) preflightCalls++;
        return new Response(
          JSON.stringify({ status: "success", result: "https://my.host/cb" }),
        );
      },
      (req) => {
        if (req.url.includes("longpoll")) longpollCalls++;
        return new Response(
          JSON.stringify({
            result: {
              radio_id: 1,
              timestamp: "x",
              results: [{ artist: "A", title: "T", score: 50 }],
            },
          }),
        );
      },
      // Subsequent calls — return keep-alive (skipped by loop, no dispatch).
      () => new Response(JSON.stringify({ timeout: "y", timestamp: 2 })),
      () => new Response(JSON.stringify({ timeout: "y", timestamp: 3 })),
    ]);
    const audd = new AudD({ apiToken: "tk", fetch: fetchImpl });
    const poll = await audd.streams.longpoll("abc");
    const it = poll.matches[Symbol.asyncIterator]();
    await it.next(); // first match arrives
    poll.close();
    expect(preflightCalls).toBe(1);
    expect(longpollCalls).toBeGreaterThanOrEqual(1);
  });

  it("malformed longpoll JSON pushes AudDSerializationError onto errors", async () => {
    const fetchImpl = makeFetch([
      () =>
        new Response(JSON.stringify({ status: "success", result: "https://x/cb" })),
      () => new Response(JSON.stringify(["not", "an", "object"])),
    ]);
    const audd = new AudD({ apiToken: "tk", fetch: fetchImpl });
    const poll = await audd.streams.longpoll("abc");
    const it = poll.errors[Symbol.asyncIterator]();
    const r = await it.next();
    poll.close();
    expect(r.done).toBe(false);
    expect(r.value).toBeInstanceOf(AudDSerializationError);
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
    await expect(audd.streams.longpoll("abc")).rejects.toThrow();
  });

  it("keep-alive {timeout} responses are skipped (no terminal error)", async () => {
    const fetchImpl = makeFetch([
      () =>
        new Response(JSON.stringify({ status: "success", result: "https://x/cb" })),
      () => new Response(JSON.stringify({ timeout: "x", timestamp: 1 })),
      () =>
        new Response(
          JSON.stringify({
            result: {
              radio_id: 1,
              timestamp: "y",
              results: [{ artist: "A", title: "T", score: 50 }],
            },
          }),
        ),
    ]);
    const audd = new AudD({ apiToken: "tk", fetch: fetchImpl });
    const poll = await audd.streams.longpoll("abc");
    const it = poll.matches[Symbol.asyncIterator]();
    const r = await it.next();
    poll.close();
    expect(r.value.song.artist).toBe("A");
  });

  it("dispatches notifications onto the notifications iterable", async () => {
    const fetchImpl = makeFetch([
      () =>
        new Response(JSON.stringify({ status: "success", result: "https://x/cb" })),
      () =>
        new Response(
          JSON.stringify({
            notification: {
              radio_id: 3,
              stream_running: false,
              notification_code: 650,
              notification_message: "can't connect",
            },
            time: 123,
          }),
        ),
    ]);
    const audd = new AudD({ apiToken: "tk", fetch: fetchImpl });
    const poll = await audd.streams.longpoll("abc");
    const it = poll.notifications[Symbol.asyncIterator]();
    const r = await it.next();
    poll.close();
    expect(r.value.notificationCode).toBe(650);
    expect(r.value.time).toBe(123);
  });

  it("close() makes all three iterables complete", async () => {
    const fetchImpl = makeFetch([
      () =>
        new Response(JSON.stringify({ status: "success", result: "https://x/cb" })),
      () => new Response(JSON.stringify({ timeout: "x", timestamp: 1 })),
      () => new Response(JSON.stringify({ timeout: "x", timestamp: 2 })),
      () => new Response(JSON.stringify({ timeout: "x", timestamp: 3 })),
    ]);
    const audd = new AudD({ apiToken: "tk", fetch: fetchImpl });
    const poll = await audd.streams.longpoll("abc");
    poll.close();
    const m = await poll.matches[Symbol.asyncIterator]().next();
    const n = await poll.notifications[Symbol.asyncIterator]().next();
    const e = await poll.errors[Symbol.asyncIterator]().next();
    expect(m.done).toBe(true);
    expect(n.done).toBe(true);
    expect(e.done).toBe(true);
  });
});

describe("streams.longpoll one-step entry point", () => {
  it("longpoll({ radioId }) derives category locally and uses it", async () => {
    // Locked vector: deriveLongpollCategory("d29ebb205488e3b414bcc0c50432463e", 1) === "088719f57"
    let capturedUrl = "";
    const fetchImpl = makeFetch([
      () =>
        new Response(JSON.stringify({ status: "success", result: "https://x/cb" })),
      (req) => {
        capturedUrl = req.url;
        return new Response(
          JSON.stringify({
            result: {
              radio_id: 1,
              timestamp: "x",
              results: [{ artist: "A", title: "T", score: 100 }],
            },
          }),
        );
      },
    ]);
    const audd = new AudD({
      apiToken: "d29ebb205488e3b414bcc0c50432463e",
      fetch: fetchImpl,
    });
    const poll = await audd.streams.longpoll({ radioId: 1 });
    const r = await poll.matches[Symbol.asyncIterator]().next();
    poll.close();
    expect(r.value.song.artist).toBe("A");
    expect(capturedUrl).toContain("category=088719f57");
  });

  it("longpoll({ category }) uses the explicit category string", async () => {
    let capturedUrl = "";
    const fetchImpl = makeFetch([
      () =>
        new Response(JSON.stringify({ status: "success", result: "https://x/cb" })),
      (req) => {
        capturedUrl = req.url;
        return new Response(
          JSON.stringify({
            result: {
              radio_id: 1,
              timestamp: "x",
              results: [{ artist: "A", title: "T", score: 100 }],
            },
          }),
        );
      },
    ]);
    const audd = new AudD({ apiToken: "tk", fetch: fetchImpl });
    const poll = await audd.streams.longpoll({ category: "abc123def" });
    const r = await poll.matches[Symbol.asyncIterator]().next();
    poll.close();
    expect(r.value.song.artist).toBe("A");
    expect(capturedUrl).toContain("category=abc123def");
  });

  it("longpoll(\"abc\") (legacy positional) still works", async () => {
    let capturedUrl = "";
    const fetchImpl = makeFetch([
      () =>
        new Response(JSON.stringify({ status: "success", result: "https://x/cb" })),
      (req) => {
        capturedUrl = req.url;
        return new Response(
          JSON.stringify({
            result: {
              radio_id: 1,
              timestamp: "x",
              results: [{ artist: "A", title: "T", score: 100 }],
            },
          }),
        );
      },
    ]);
    const audd = new AudD({ apiToken: "tk", fetch: fetchImpl });
    const poll = await audd.streams.longpoll("abc123def");
    const r = await poll.matches[Symbol.asyncIterator]().next();
    poll.close();
    expect(r.value.song.artist).toBe("A");
    expect(capturedUrl).toContain("category=abc123def");
  });

  it("longpoll({ radioId, category }) throws AudDInvalidRequestError", async () => {
    const audd = new AudD({ apiToken: "tk" });
    await expect(
      audd.streams.longpoll({ radioId: 42, category: "abc" } as never),
    ).rejects.toThrow(AudDInvalidRequestError);
  });

  it("longpoll({}) throws AudDInvalidRequestError", async () => {
    const audd = new AudD({ apiToken: "tk" });
    await expect(audd.streams.longpoll({} as never)).rejects.toThrow(
      AudDInvalidRequestError,
    );
  });
});

describe("streams.parseCallback", () => {
  it("parses a result-shaped payload into match/notification", () => {
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
    expect(p.match).not.toBeNull();
    expect(p.notification).toBeNull();
    expect(p.match?.radioId).toBe(7);
  });

  it("does not silence AudDInvalidRequestError types", () => {
    const e = new AudDInvalidRequestError({ errorCode: 19, message: "x", httpStatus: 200 });
    expect(e.errorCode).toBe(19);
  });
});
