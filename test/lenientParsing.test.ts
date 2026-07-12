/**
 * Regression tests for the lenient-parsing invariant: public methods never
 * throw on missing or wrong-typed response fields — they degrade (null
 * result, skipped entry) and keep going.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { AudD } from "../src/client.js";
import {
  parseEnterpriseMatch,
  parseLyricsResult,
  parseRecognitionResult,
  parseStream,
  parseStreamCallbackMatch,
  parseStreamCallbackNotification,
} from "../src/models.js";

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

describe("lenient parsing — scalar coercion", () => {
  describe("wrong-typed → string (canonical rendering)", () => {
    it("coerces a number to its canonical string, not dropped", () => {
      // artist is a string field; a numeric server value renders exactly.
      expect(parseRecognitionResult({ artist: 123 }).artist).toBe("123");
      expect(parseRecognitionResult({ artist: 8.5 }).artist).toBe("8.5");
    });

    it("coerces a boolean to 'true'/'false'", () => {
      expect(parseRecognitionResult({ artist: true }).artist).toBe("true");
      expect(parseRecognitionResult({ artist: false }).artist).toBe("false");
    });

    it("drops objects/arrays/null to undefined (not representable as scalar)", () => {
      expect(parseRecognitionResult({ artist: { a: 1 } }).artist).toBeUndefined();
      expect(parseRecognitionResult({ artist: [1, 2] }).artist).toBeUndefined();
      expect(parseRecognitionResult({ artist: null }).artist).toBeUndefined();
    });
  });

  describe("wrong-typed → number (float field: score)", () => {
    it("parses a numeric string", () => {
      expect(parseEnterpriseMatch({ score: "85" }).score).toBe(85);
      expect(parseEnterpriseMatch({ score: " 8.5 " }).score).toBe(8.5);
      expect(parseEnterpriseMatch({ score: "-3" }).score).toBe(-3);
      expect(parseEnterpriseMatch({ score: "1e2" }).score).toBe(100);
    });

    it("keeps a genuine number as-is (no truncation for float fields)", () => {
      expect(parseEnterpriseMatch({ score: 88.7 }).score).toBe(88.7);
    });

    it("maps booleans to 0/1", () => {
      expect(parseEnterpriseMatch({ score: true }).score).toBe(1);
      expect(parseEnterpriseMatch({ score: false }).score).toBe(0);
    });

    it("degrades non-numeric strings to undefined (never a garbage 0)", () => {
      expect(parseEnterpriseMatch({ score: "abc" }).score).toBeUndefined();
      expect(parseEnterpriseMatch({ score: "85abc" }).score).toBeUndefined();
      expect(parseEnterpriseMatch({ score: "NaN" }).score).toBeUndefined();
      expect(parseEnterpriseMatch({ score: "Infinity" }).score).toBeUndefined();
    });

    it("degrades empty/whitespace strings to undefined (JS Number('') === 0 pitfall)", () => {
      expect(parseEnterpriseMatch({ score: "" }).score).toBeUndefined();
      expect(parseEnterpriseMatch({ score: "   " }).score).toBeUndefined();
    });

    it("degrades objects/arrays to undefined", () => {
      expect(parseEnterpriseMatch({ score: {} }).score).toBeUndefined();
      expect(parseEnterpriseMatch({ score: [1] }).score).toBeUndefined();
    });
  });

  describe("wrong-typed → integer (id/count/offset/timestamp fields)", () => {
    it("parses a numeric string for an integer-typed field", () => {
      expect(parseStream({ radio_id: "7" }).radioId).toBe(7);
    });

    it("truncates floats toward zero for integer-typed fields", () => {
      expect(parseStream({ radio_id: 7.9 }).radioId).toBe(7);
      expect(parseStream({ radio_id: -7.9 }).radioId).toBe(-7);
      expect(parseStream({ radio_id: "7.9" }).radioId).toBe(7);
      expect(parseRecognitionResult({ audio_id: 146.99 }).audioId).toBe(146);
    });

    it("maps booleans to 0/1", () => {
      expect(parseStream({ radio_id: true }).radioId).toBe(1);
      expect(parseStream({ radio_id: false }).radioId).toBe(0);
    });

    it("degrades non-numeric/empty strings to undefined (never a garbage 0)", () => {
      expect(parseStream({ radio_id: "abc" }).radioId).toBeUndefined();
      expect(parseStream({ radio_id: "" }).radioId).toBeUndefined();
      expect(parseStream({ radio_id: "7a" }).radioId).toBeUndefined();
    });

    it("coerces other integer-typed fields (offsets, ids, counts)", () => {
      const m = parseEnterpriseMatch({ start_offset: "1500", end_offset: 3200.6 });
      expect(m.startOffset).toBe(1500);
      expect(m.endOffset).toBe(3200);
      const lyr = parseLyricsResult({ song_id: "42", artist_id: 7.4 });
      expect(lyr.songId).toBe(42);
      expect(lyr.artistId).toBe(7);
      const notif = parseStreamCallbackNotification({ notification_code: "610" });
      expect(notif.notificationCode).toBe(610);
      const cbMatch = parseStreamCallbackMatch({ play_length: "12", radio_id: "3" });
      expect(cbMatch.playLength).toBe(12);
      expect(cbMatch.radioId).toBe(3);
    });
  });

  describe("wrong-typed → boolean (strict whitelist, both directions)", () => {
    it("number → bool by (v !== 0)", () => {
      expect(parseStream({ stream_running: 1 }).streamRunning).toBe(true);
      expect(parseStream({ stream_running: 0 }).streamRunning).toBe(false);
      expect(parseStream({ stream_running: -1 }).streamRunning).toBe(true);
    });

    it("truthy string tokens → true", () => {
      for (const s of ["true", "1", "yes", "on", "TRUE", " Yes "]) {
        expect(parseStream({ stream_running: s }).streamRunning).toBe(true);
      }
    });

    it("falsy string tokens → false", () => {
      for (const s of ["false", "0", "no", "off", "", "FALSE", " No "]) {
        expect(parseStream({ stream_running: s }).streamRunning).toBe(false);
      }
    });

    it("unrecognized string → undefined (not coerced to true)", () => {
      expect(parseStream({ stream_running: "maybe" }).streamRunning).toBeUndefined();
      expect(parseStream({ stream_running: "yep" }).streamRunning).toBeUndefined();
    });

    it("objects/arrays → undefined", () => {
      expect(parseStream({ stream_running: {} }).streamRunning).toBeUndefined();
      expect(parseStream({ stream_running: [] }).streamRunning).toBeUndefined();
    });
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
