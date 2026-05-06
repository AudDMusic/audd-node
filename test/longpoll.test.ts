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
  it("dispatches matches onto poll.matches", async () => {
    const fetchImpl = makeFetch([
      (req) => {
        expect(req.url).toContain("category=abc");
        expect(req.url).toContain("timeout=30");
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
    const c = new LongpollConsumer("abc", { fetch: fetchImpl });
    const poll = c.iterate({ timeout: 30 });
    const r = await poll.matches[Symbol.asyncIterator]().next();
    poll.close();
    expect(r.value.song.artist).toBe("A");
  });

  it("dispatches notifications onto poll.notifications", async () => {
    const fetchImpl = makeFetch([
      () =>
        new Response(
          JSON.stringify({
            notification: {
              radio_id: 3,
              stream_running: false,
              notification_code: 650,
              notification_message: "can't connect",
            },
            time: 99,
          }),
        ),
    ]);
    const c = new LongpollConsumer("abc", { fetch: fetchImpl });
    const poll = c.iterate();
    const r = await poll.notifications[Symbol.asyncIterator]().next();
    poll.close();
    expect(r.value.notificationCode).toBe(650);
    expect(r.value.time).toBe(99);
  });

  it("does NOT include api_token in URL (tokenless)", async () => {
    let capturedUrl = "";
    const fetchImpl = makeFetch([
      (req) => {
        capturedUrl = req.url;
        return new Response(JSON.stringify({ timeout: "x" }));
      },
      // additional polls (loop continues after keep-alive)
      () => new Response(JSON.stringify({ timeout: "x" })),
      () => new Response(JSON.stringify({ timeout: "x" })),
    ]);
    const c = new LongpollConsumer("abc", { fetch: fetchImpl });
    const poll = c.iterate();
    // Just open then close — the URL is captured on the very first request.
    await new Promise((r) => setTimeout(r, 10));
    poll.close();
    expect(capturedUrl).not.toContain("api_token");
  });

  it("HTTP non-2xx pushes AudDServerError onto poll.errors", async () => {
    const fetchImpl = makeFetch([
      () => new Response("forbidden", { status: 403 }),
    ]);
    const c = new LongpollConsumer("abc", { fetch: fetchImpl, maxRetries: 1 });
    const poll = c.iterate();
    const r = await poll.errors[Symbol.asyncIterator]().next();
    poll.close();
    expect(r.value).toBeInstanceOf(AudDServerError);
  });

  it("2xx with non-object JSON pushes AudDSerializationError", async () => {
    const fetchImpl = makeFetch([
      () => new Response(JSON.stringify(["not", "an", "object"]), { status: 200 }),
    ]);
    const c = new LongpollConsumer("abc", { fetch: fetchImpl });
    const poll = c.iterate();
    const r = await poll.errors[Symbol.asyncIterator]().next();
    poll.close();
    expect(r.value).toBeInstanceOf(AudDSerializationError);
  });

  it("retries 5xx (configurable maxRetries)", async () => {
    const fetchImpl = makeFetch([
      () => new Response("oops", { status: 503 }),
      () =>
        new Response(
          JSON.stringify({
            result: {
              radio_id: 1,
              timestamp: "x",
              results: [{ artist: "A", title: "T", score: 100 }],
            },
          }),
        ),
    ]);
    const c = new LongpollConsumer("abc", {
      fetch: fetchImpl,
      maxRetries: 3,
      backoffFactorMs: 0,
    });
    const poll = c.iterate();
    const r = await poll.matches[Symbol.asyncIterator]().next();
    poll.close();
    expect(r.value.song.artist).toBe("A");
  });

  it("connection error wraps in AudDConnectionError", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof globalThis.fetch;
    const c = new LongpollConsumer("abc", { fetch: fetchImpl, maxRetries: 1 });
    const poll = c.iterate();
    const r = await poll.errors[Symbol.asyncIterator]().next();
    poll.close();
    expect(r.value).toBeInstanceOf(AudDConnectionError);
  });

  it("uses since_time on subsequent iterations", async () => {
    const urls: string[] = [];
    const fetchImpl = makeFetch([
      (req) => {
        urls.push(req.url);
        return new Response(
          JSON.stringify({
            result: {
              radio_id: 1,
              timestamp: "ts1",
              results: [{ artist: "A", title: "T", score: 1 }],
            },
            timestamp: 100,
          }),
        );
      },
      (req) => {
        urls.push(req.url);
        return new Response(
          JSON.stringify({
            result: {
              radio_id: 1,
              timestamp: "ts2",
              results: [{ artist: "B", title: "T", score: 1 }],
            },
            timestamp: 200,
          }),
        );
      },
      // tail keep-alives — loop keeps running; we close before they matter
      () => new Response(JSON.stringify({ timeout: "x" })),
    ]);
    const c = new LongpollConsumer("abc", { fetch: fetchImpl });
    const poll = c.iterate();
    const it = poll.matches[Symbol.asyncIterator]();
    await it.next();
    await it.next();
    poll.close();
    expect(urls[0]).not.toContain("since_time");
    expect(urls[1]).toContain("since_time=100");
  });

  it("close() and [Symbol.asyncDispose]() do not throw", async () => {
    const c = new LongpollConsumer("abc");
    c.close();
    await c[Symbol.asyncDispose]();
  });

  it("poll.close() makes all three iterables complete", async () => {
    const fetchImpl = makeFetch([
      () => new Response(JSON.stringify({ timeout: "x" })),
      () => new Response(JSON.stringify({ timeout: "x" })),
      () => new Response(JSON.stringify({ timeout: "x" })),
    ]);
    const c = new LongpollConsumer("abc", { fetch: fetchImpl });
    const poll = c.iterate();
    poll.close();
    const m = await poll.matches[Symbol.asyncIterator]().next();
    const n = await poll.notifications[Symbol.asyncIterator]().next();
    const e = await poll.errors[Symbol.asyncIterator]().next();
    expect(m.done).toBe(true);
    expect(n.done).toBe(true);
    expect(e.done).toBe(true);
  });
});
