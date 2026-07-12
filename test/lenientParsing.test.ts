/**
 * Regression tests for the lenient-parsing invariant: public methods never
 * throw on missing or wrong-typed response fields — they degrade (null
 * result, skipped entry) and keep going.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { AudD } from "../src/client.js";

afterEach(() => {
  vi.restoreAllMocks();
});

function jsonResponses(...bodies: unknown[]): typeof fetch {
  let i = 0;
  return vi.fn(async () => {
    const body = bodies[Math.min(i, bodies.length - 1)];
    i += 1;
    return new Response(JSON.stringify(body), {
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
}

describe("lenient parsing — recognize", () => {
  it("wrong-typed result degrades to null (no match), not a throw", async () => {
    const audd = new AudD({
      apiToken: "t",
      fetch: jsonResponses({ status: "success", result: "weird" }),
    });
    await expect(audd.recognize("https://x.mp3")).resolves.toBeNull();
  });

  it("array-typed result degrades to null", async () => {
    const audd = new AudD({
      apiToken: "t",
      fetch: jsonResponses({ status: "success", result: [1, 2, 3] }),
    });
    await expect(audd.recognize("https://x.mp3")).resolves.toBeNull();
  });
});

describe("lenient parsing — recognizeEnterprise", () => {
  it("skips null chunks and non-object songs entries", async () => {
    const audd = new AudD({
      apiToken: "t",
      fetch: jsonResponses({
        status: "success",
        result: [
          null,
          "junk",
          { songs: [{ artist: "A", title: "T", score: 90 }, 42, null], offset: "00:00" },
        ],
      }),
    });
    const matches = await audd.recognizeEnterprise("https://x.mp3", { limit: 1 });
    expect(matches).toHaveLength(1);
    expect(matches[0]?.artist).toBe("A");
  });

  it("wrong-typed result degrades to an empty match list", async () => {
    const audd = new AudD({
      apiToken: "t",
      fetch: jsonResponses({ status: "success", result: "weird" }),
    });
    await expect(
      audd.recognizeEnterprise("https://x.mp3", { limit: 1 }),
    ).resolves.toEqual([]);
  });
});

describe("lenient parsing — streams.list", () => {
  it("skips non-object array entries", async () => {
    const audd = new AudD({
      apiToken: "t",
      fetch: jsonResponses({
        status: "success",
        result: [{ radio_id: 7, url: "https://s/live.mp3" }, "junk", null, 42],
      }),
    });
    const streams = await audd.streams.list();
    expect(streams).toHaveLength(1);
    expect(streams[0]?.radioId).toBe(7);
  });
});

describe("lenient parsing — longpoll loop", () => {
  it("a wrong-typed notification does not kill the loop; later events still arrive", async () => {
    const fetchMock = jsonResponses(
      { notification: 42, timestamp: 1 }, // wrong-typed — must be skipped
      {
        result: { radio_id: 1, results: [{ artist: "A", title: "T" }] },
        timestamp: 2,
      },
      { timeout: true, timestamp: 3 }, // keep-alives from here on
    );
    const audd = new AudD({ apiToken: "t", fetch: fetchMock });
    const poll = await audd.streams.longpoll("abc123def", { skipCallbackCheck: true });
    try {
      const first = await poll.matches[Symbol.asyncIterator]().next();
      expect(first.done).toBe(false);
      expect(first.value?.song?.artist).toBe("A");
    } finally {
      poll.close();
    }
  });
});
