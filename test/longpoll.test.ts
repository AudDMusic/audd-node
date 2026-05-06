import { describe, expect, it, vi } from "vitest";
import {
  AudDConnectionError,
  AudDSerializationError,
  AudDServerError,
} from "../src/errors.js";
import { LongpollConsumer } from "../src/longpoll.js";

function makeFetch(handlers: ((req: Request) => Response | Promise<Response>)[]) {
  let i = 0;
  const fn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init);
    const handler = handlers[i++];
    if (!handler) throw new Error(`unexpected request #${i}`);
    return handler(req);
  });
  return fn as unknown as typeof globalThis.fetch;
}

describe("LongpollConsumer", () => {
  it("yields parsed event objects", async () => {
    const fetchImpl = makeFetch([
      (req) => {
        expect(req.url).toContain("category=abc");
        expect(req.url).toContain("timeout=30");
        return new Response(
          JSON.stringify({ timeout: "no events before timeout", timestamp: 12345 }),
        );
      },
    ]);
    const c = new LongpollConsumer("abc", { fetch: fetchImpl });
    const it_ = c.iterate({ timeout: 30 })[Symbol.asyncIterator]();
    const r = await it_.next();
    expect(r.value).toMatchObject({ timeout: "no events before timeout" });
  });

  it("does NOT include api_token in URL (tokenless)", async () => {
    let capturedUrl = "";
    const fetchImpl = makeFetch([
      (req) => {
        capturedUrl = req.url;
        return new Response(JSON.stringify({ timeout: "x" }));
      },
    ]);
    const c = new LongpollConsumer("abc", { fetch: fetchImpl });
    await c.iterate()[Symbol.asyncIterator]().next();
    expect(capturedUrl).not.toContain("api_token");
  });

  it("HTTP non-2xx raises AudDServerError (S5: not silent loop)", async () => {
    const fetchImpl = makeFetch([
      () => new Response("forbidden", { status: 403 }),
    ]);
    const c = new LongpollConsumer("abc", {
      fetch: fetchImpl,
      maxRetries: 1,
    });
    const it_ = c.iterate()[Symbol.asyncIterator]();
    await expect(it_.next()).rejects.toThrow(AudDServerError);
  });

  it("2xx with non-object JSON raises AudDSerializationError", async () => {
    const fetchImpl = makeFetch([
      () => new Response(JSON.stringify(["not", "an", "object"]), { status: 200 }),
    ]);
    const c = new LongpollConsumer("abc", { fetch: fetchImpl });
    const it_ = c.iterate()[Symbol.asyncIterator]();
    await expect(it_.next()).rejects.toThrow(AudDSerializationError);
  });

  it("retries 5xx (S6: configurable retries)", async () => {
    const fetchImpl = makeFetch([
      () => new Response("oops", { status: 503 }),
      () => new Response(JSON.stringify({ timeout: "ok" })),
    ]);
    const c = new LongpollConsumer("abc", {
      fetch: fetchImpl,
      maxRetries: 3,
      backoffFactorMs: 0,
    });
    const it_ = c.iterate()[Symbol.asyncIterator]();
    const r = await it_.next();
    expect(r.value).toMatchObject({ timeout: "ok" });
  });

  it("connection error wraps in AudDConnectionError", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof globalThis.fetch;
    const c = new LongpollConsumer("abc", {
      fetch: fetchImpl,
      maxRetries: 1,
    });
    const it_ = c.iterate()[Symbol.asyncIterator]();
    await expect(it_.next()).rejects.toThrow(AudDConnectionError);
  });

  it("uses since_time on subsequent iterations", async () => {
    const urls: string[] = [];
    const fetchImpl = makeFetch([
      (req) => {
        urls.push(req.url);
        return new Response(JSON.stringify({ timeout: "x", timestamp: 100 }));
      },
      (req) => {
        urls.push(req.url);
        return new Response(JSON.stringify({ timeout: "y", timestamp: 200 }));
      },
    ]);
    const c = new LongpollConsumer("abc", { fetch: fetchImpl });
    const it_ = c.iterate()[Symbol.asyncIterator]();
    await it_.next();
    await it_.next();
    expect(urls[0]).not.toContain("since_time");
    expect(urls[1]).toContain("since_time=100");
  });

  it("close() and [Symbol.asyncDispose]() do not throw", async () => {
    const c = new LongpollConsumer("abc");
    c.close();
    await c[Symbol.asyncDispose]();
  });
});
