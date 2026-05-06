import { describe, expect, it } from "vitest";
import {
  addReturnToUrl,
  deriveLongpollCategory,
  DuplicateReturnParameterError,
  parseCallback,
} from "../src/helpers.js";

describe("deriveLongpollCategory", () => {
  it("matches the byte-for-byte vector verified against audd-python", () => {
    // Same vector as audd-python's test_callbacks.py.
    const cat = deriveLongpollCategory("d29ebb205488e3b414bcc0c50432463e", 1);
    expect(cat).toBe("088719f57");
  });

  it("returns 9 hex chars", () => {
    const cat = deriveLongpollCategory("any-token", 42);
    expect(cat).toMatch(/^[0-9a-f]{9}$/);
  });

  it("differs by radio_id", () => {
    const a = deriveLongpollCategory("token", 1);
    const b = deriveLongpollCategory("token", 2);
    expect(a).not.toBe(b);
  });
});

describe("addReturnToUrl", () => {
  it("returns URL unchanged when metadata is undefined", () => {
    expect(addReturnToUrl("https://x/cb", undefined)).toBe("https://x/cb");
  });

  it("appends ?return=<value> for a new URL", () => {
    expect(addReturnToUrl("https://x/cb", "apple_music")).toBe(
      "https://x/cb?return=apple_music",
    );
  });

  it("joins array values with commas", () => {
    expect(addReturnToUrl("https://x/cb", ["apple_music", "spotify"])).toBe(
      "https://x/cb?return=apple_music%2Cspotify",
    );
  });

  it("merges with existing query string using &", () => {
    expect(addReturnToUrl("https://x/cb?utm=1", "spotify")).toBe(
      "https://x/cb?utm=1&return=spotify",
    );
  });

  it("raises DuplicateReturnParameterError when URL already has ?return=", () => {
    expect(() => addReturnToUrl("https://x/cb?return=spotify", "apple_music")).toThrow(
      DuplicateReturnParameterError,
    );
  });
});

describe("parseCallback re-export", () => {
  it("parses a result-shaped payload into { match, notification: null }", () => {
    const p = parseCallback({
      status: "success",
      result: {
        radio_id: 7,
        timestamp: "2020-04-13 10:31:43",
        play_length: 100,
        results: [{ artist: "x", title: "y", score: 50 }],
      },
    });
    expect(p.match).not.toBeNull();
    expect(p.notification).toBeNull();
    expect(p.match?.radioId).toBe(7);
    expect(p.match?.song.artist).toBe("x");
    expect(p.match?.alternatives).toEqual([]);
  });

  it("parses a notification-shaped payload into { match: null, notification }", () => {
    const p = parseCallback({
      status: "-",
      notification: {
        radio_id: 3,
        stream_running: false,
        notification_code: 650,
        notification_message: "can't connect",
      },
      time: 1587939136,
    });
    expect(p.match).toBeNull();
    expect(p.notification).not.toBeNull();
    expect(p.notification?.notificationCode).toBe(650);
    expect(p.notification?.time).toBe(1587939136);
  });

  it("accepts a string body", () => {
    const p = parseCallback(
      JSON.stringify({
        result: {
          radio_id: 7,
          timestamp: "x",
          results: [{ artist: "a", title: "t", score: 90 }],
        },
      }),
    );
    expect(p.match?.song.title).toBe("t");
  });

  it("throws on invalid JSON string", () => {
    expect(() => parseCallback("not json")).toThrowError(/not valid JSON/);
  });

  it("throws when neither result nor notification present", () => {
    expect(() => parseCallback({ foo: "bar" })).toThrowError(/neither result nor notification/);
  });

  it("alternatives carry trailing results entries (variant catalog releases)", () => {
    const p = parseCallback({
      result: {
        radio_id: 5,
        timestamp: "x",
        results: [
          { artist: "Top", title: "T", score: 100 },
          { artist: "Variant feat. Other", title: "T (live)", score: 80 },
        ],
      },
    });
    expect(p.match?.song.artist).toBe("Top");
    expect(p.match?.alternatives).toHaveLength(1);
    expect(p.match?.alternatives[0]?.artist).toBe("Variant feat. Other");
    expect(p.match?.alternatives[0]?.title).toBe("T (live)");
  });
});
