/**
 * The longpoll loop against the response shapes the endpoint sends: an
 * `events` list, a timeout, and an HTTP-200 error body (fixtures copied from
 * audd-openapi/fixtures), plus the top-level `result` / `notification` shape
 * and bodies it can't read. Both entry points share the loop: the
 * authenticated `audd.streams.longpoll` and the tokenless `LongpollConsumer`.
 */
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AudD } from "../src/client.js";
import {
  AudDAuthenticationError,
  AudDConnectionError,
  AudDInvalidRequestError,
  AudDServerError,
} from "../src/errors.js";
import { LongpollConsumer } from "../src/longpoll.js";
import type { LongpollPoll } from "../src/longpollCore.js";

const TOKEN = "longpoll-test-token-1234567890";

function fixture(name: string): string {
  return readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");
}

const EVENTS = fixture("longpoll_events.json");
const NO_EVENTS = fixture("longpoll_no_events.json");
const ERROR = fixture("longpoll_error.json");

type Responder = (req: Request) => Response | Promise<Response>;

/**
 * A fetch that answers request N with `script[N]`, then with `fallback`
 * when given, and otherwise holds the request open (as the longpoll server
 * does) until its signal aborts.
 */
function scriptedFetch(script: Responder[], fallback?: Responder) {
  const requests: Request[] = [];
  const fn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init);
    requests.push(req);
    const responder = script[requests.length - 1] ?? fallback;
    if (responder !== undefined) return responder(req);
    return new Promise<Response>((_, reject) => {
      init?.signal?.addEventListener(
        "abort",
        () => {
          const err = new Error("aborted");
          err.name = "AbortError";
          reject(err);
        },
        { once: true },
      );
    });
  });
  return { fetch: fn as unknown as typeof globalThis.fetch, requests };
}

const json = (body: string): Responder => () =>
  new Response(body, { headers: { "content-type": "application/json" } });

interface Entry {
  name: string;
  start(fetchImpl: typeof globalThis.fetch, opts?: { sinceTime?: number }): Promise<LongpollPoll>;
}

const ENTRIES: Entry[] = [
  {
    name: "audd.streams.longpoll",
    start: (fetchImpl, opts = {}) =>
      new AudD({ apiToken: TOKEN, fetch: fetchImpl, backoffFactorMs: 0 }).streams.longpoll({
        radioId: 7,
        skipCallbackCheck: true,
        ...opts,
      }),
  },
  {
    name: "LongpollConsumer",
    start: (fetchImpl, opts = {}) =>
      Promise.resolve(
        new LongpollConsumer("92b1cc7f0", { fetch: fetchImpl, backoffFactorMs: 0 }).iterate(opts),
      ),
  },
];

/** Up to `n` items; stops early when the iterable completes. */
async function take<T>(iterable: AsyncIterable<T>, n: number): Promise<T[]> {
  const out: T[] = [];
  const it = iterable[Symbol.asyncIterator]();
  while (out.length < n) {
    const r = await it.next();
    if (r.done === true) break;
    out.push(r.value);
  }
  return out;
}

function query(req: Request | undefined, key: string): string | null {
  if (req === undefined) throw new Error("request was not sent");
  return new URL(req.url).searchParams.get(key);
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe.each(ENTRIES)("longpoll responses via $name", (entry) => {
  it("events fixture: delivers both songs in order, then resumes from the newest timestamp", async () => {
    const { fetch, requests } = scriptedFetch([json(EVENTS)]);
    const poll = await entry.start(fetch);
    try {
      const got = await take(poll.matches, 2);
      expect(got.map((m) => [m.radioId, m.song?.artist, m.song?.title])).toEqual([
        [7, "Alan Walker, A$AP Rocky", "Live Fast (PUBGM)"],
        [7, "Tears For Fears", "Everybody Wants To Rule The World"],
      ]);
      expect(got[0]?.timestamp).toBe("2026-11-24 19:10:11");
      expect(got[1]?.playLength).toBe(96);
      await vi.waitFor(() => expect(requests.length).toBe(2));
      expect(query(requests[0], "since_time")).toBeNull();
      expect(query(requests[1], "since_time")).toBe("1795547548112");
    } finally {
      poll.close();
    }
  });

  it("timeout fixture: delivers nothing; the next request sends its timestamp", async () => {
    const { fetch, requests } = scriptedFetch([json(NO_EVENTS)]);
    const poll = await entry.start(fetch);
    await vi.waitFor(() => expect(requests.length).toBe(2));
    poll.close();
    expect(query(requests[1], "since_time")).toBe("1777901270049");
    expect(await take(poll.matches, 10)).toEqual([]);
    expect(await take(poll.notifications, 10)).toEqual([]);
    expect(await take(poll.errors, 10)).toEqual([]);
  });

  it("error fixture: one AudDInvalidRequestError with the server's text, one request, poll ends", async () => {
    const { fetch, requests } = scriptedFetch([], json(ERROR));
    const poll = await entry.start(fetch);
    const errs = await take(poll.errors, 10);
    expect(errs).toHaveLength(1);
    const err = errs[0];
    expect(err).toBeInstanceOf(AudDInvalidRequestError);
    expect((err as AudDInvalidRequestError).serverMessage).toBe(
      "Invalid timeout arg.  Must be 1-120.",
    );
    expect(err?.message).toContain("Invalid timeout arg.  Must be 1-120.");
    expect((await poll.matches[Symbol.asyncIterator]().next()).done).toBe(true);
    await new Promise((r) => setTimeout(r, 50));
    expect(requests).toHaveLength(1);
    poll.close();
  });

  it("top-level result / notification bodies still deliver and advance since_time", async () => {
    const { fetch, requests } = scriptedFetch([
      json(
        JSON.stringify({
          result: { radio_id: 3, timestamp: "t", results: [{ artist: "A", title: "T", score: 90 }] },
          timestamp: 100,
        }),
      ),
      json(
        JSON.stringify({
          status: "-",
          notification: { radio_id: 3, stream_running: false, notification_code: 650 },
          time: 1587939136,
          timestamp: 200,
        }),
      ),
    ]);
    const poll = await entry.start(fetch);
    try {
      const [m] = await take(poll.matches, 1);
      expect(m?.song?.artist).toBe("A");
      const [n] = await take(poll.notifications, 1);
      expect(n?.notificationCode).toBe(650);
      expect(n?.time).toBe(1587939136);
      await vi.waitFor(() => expect(requests.length).toBe(3));
      expect(query(requests[1], "since_time")).toBe("100");
      expect(query(requests[2], "since_time")).toBe("200");
    } finally {
      poll.close();
    }
  });

  it("decodes string data, skips unreadable and empty-results events, keeps polling", async () => {
    const body = JSON.stringify({
      events: [
        { timestamp: 10, category: "c", data: "not json" },
        { timestamp: 11, category: "c", data: { status: "success", result: { radio_id: 1, results: [] } } },
        {
          timestamp: 12,
          category: "c",
          data: JSON.stringify({
            status: "success",
            result: { radio_id: 1, results: [{ artist: "String", title: "Data" }] },
          }),
        },
        "not an event",
        {
          timestamp: 14,
          category: "c",
          data: {
            status: "-",
            notification: { radio_id: 1, stream_running: true, notification_code: 0 },
            time: 5,
          },
        },
        { timestamp: 13, category: "c", data: { unknown: true } },
      ],
    });
    const { fetch, requests } = scriptedFetch([json(body)]);
    const poll = await entry.start(fetch);
    try {
      const [m] = await take(poll.matches, 1);
      expect(m?.song?.artist).toBe("String");
      const [n] = await take(poll.notifications, 1);
      expect(n?.notificationCode).toBe(0);
      expect(n?.time).toBe(5);
      await vi.waitFor(() => expect(requests.length).toBe(2));
      expect(query(requests[1], "since_time")).toBe("14");
    } finally {
      poll.close();
    }
    expect(await take(poll.matches, 10)).toEqual([]);
    expect(await take(poll.errors, 10)).toEqual([]);
  });

  it("an empty events list counts as nothing new: waits, then asks again with the same since_time", async () => {
    vi.useFakeTimers();
    const { fetch, requests } = scriptedFetch([json(NO_EVENTS), json('{"events":[]}')]);
    const poll = await entry.start(fetch);
    try {
      await vi.advanceTimersByTimeAsync(10);
      expect(requests).toHaveLength(2);
      await vi.advanceTimersByTimeAsync(900);
      expect(requests).toHaveLength(2);
      await vi.advanceTimersByTimeAsync(200);
      expect(requests).toHaveLength(3);
      expect(query(requests[2], "since_time")).toBe("1777901270049");
    } finally {
      poll.close();
    }
  });

  it.each([
    ["non-JSON", "<html>gateway</html>"],
    ["empty", ""],
    ["a JSON array", '["not", "an", "object"]'],
    ["an unknown object", '{"hello":"world"}'],
  ])("a %s body does not spin: backs off from 1 s up to 30 s", async (_label, body) => {
    vi.useFakeTimers();
    const { fetch, requests } = scriptedFetch([], json(body));
    const poll = await entry.start(fetch);
    try {
      await vi.advanceTimersByTimeAsync(500);
      expect(requests).toHaveLength(1);
      // Requests at 0, 1, 3, 7, 15, 31, 61, 91 s.
      await vi.advanceTimersByTimeAsync(100_000);
      expect(requests).toHaveLength(8);
    } finally {
      poll.close();
    }
    expect(await take(poll.errors, 10)).toEqual([]);
  });

  it("close() during the wait stops the loop", async () => {
    vi.useFakeTimers();
    const { fetch, requests } = scriptedFetch([], json("{}"));
    const poll = await entry.start(fetch);
    await vi.advanceTimersByTimeAsync(500);
    poll.close();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(requests).toHaveLength(1);
  });

  it("close() aborts the request that is waiting", async () => {
    const { fetch, requests } = scriptedFetch([]);
    const poll = await entry.start(fetch);
    await vi.waitFor(() => expect(requests.length).toBe(1));
    expect(requests[0]?.signal.aborted).toBe(false);
    poll.close();
    expect(requests[0]?.signal.aborted).toBe(true);
    expect(await take(poll.errors, 10)).toEqual([]);
  });

  it("an AudD-style error body ends the poll with its typed error", async () => {
    const { fetch, requests } = scriptedFetch(
      [],
      json(JSON.stringify({ status: "error", error: { error_code: 900, error_message: "bad token" } })),
    );
    const poll = await entry.start(fetch);
    const errs = await take(poll.errors, 10);
    expect(errs).toHaveLength(1);
    expect(errs[0]).toBeInstanceOf(AudDAuthenticationError);
    expect(requests).toHaveLength(1);
  });

  it("HTTP 5xx is retried with backoff and the poll carries on", async () => {
    const { fetch, requests } = scriptedFetch([
      () => new Response("bad gateway", { status: 502 }),
      json(EVENTS),
    ]);
    const poll = await entry.start(fetch);
    try {
      const got = await take(poll.matches, 2);
      expect(got).toHaveLength(2);
      expect(requests.length).toBeGreaterThanOrEqual(2);
    } finally {
      poll.close();
    }
  });

  it("a failure that outlasts the retries reaches the error path", async () => {
    const { fetch, requests } = scriptedFetch([], () => new Response("down", { status: 503 }));
    const poll = await entry.start(fetch);
    const errs = await take(poll.errors, 10);
    expect(errs).toHaveLength(1);
    expect(errs[0]).toBeInstanceOf(AudDServerError);
    expect(requests).toHaveLength(3);
  });

  it("the longpoll request carries no api_token", async () => {
    const { fetch, requests } = scriptedFetch([json(NO_EVENTS)]);
    const poll = await entry.start(fetch);
    await vi.waitFor(() => expect(requests.length).toBe(2));
    poll.close();
    for (const req of requests) {
      const url = new URL(req.url);
      expect(url.pathname).toBe("/longpoll/");
      expect(url.searchParams.has("api_token")).toBe(false);
      expect(req.url).not.toContain(TOKEN);
      for (const [, value] of req.headers) expect(value).not.toContain(TOKEN);
      expect(query(req, "timeout")).toBe("50");
    }
  });
});

describe("longpoll network errors", () => {
  it("name the underlying cause and never the token", async () => {
    const cause = Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:443"), {
      code: "ECONNREFUSED",
    });
    const fetchImpl = vi.fn(async () => {
      throw new TypeError("fetch failed", { cause });
    }) as unknown as typeof globalThis.fetch;
    const audd = new AudD({ apiToken: TOKEN, fetch: fetchImpl, maxRetries: 1 });
    const poll = await audd.streams.longpoll({ radioId: 7, skipCallbackCheck: true });
    const [err] = await take(poll.errors, 1);
    expect(err).toBeInstanceOf(AudDConnectionError);
    expect(err?.message).toBe("Network error: fetch failed (connect ECONNREFUSED 127.0.0.1:443)");
    expect(err?.message).not.toContain(TOKEN);
  });
});

describe("longpoll sinceTime option", () => {
  it.each(ENTRIES)("$name sends it on the first request", async (entry) => {
    const { fetch, requests } = scriptedFetch([]);
    const poll = await entry.start(fetch, { sinceTime: 1795547423069 });
    await vi.waitFor(() => expect(requests.length).toBe(1));
    poll.close();
    expect(query(requests[0], "since_time")).toBe("1795547423069");
  });
});
