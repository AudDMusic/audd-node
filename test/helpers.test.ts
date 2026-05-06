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
    const cat = deriveLongpollCategory("0123456789abcdef0123456789abcdef", 1);
    expect(cat).toBe("e31a31e76");
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
  it("parses a result-shaped payload", () => {
    const p = parseCallback({
      status: "success",
      result: {
        radio_id: 7,
        timestamp: "2020-04-13 10:31:43",
        play_length: 100,
        results: [{ artist: "x", title: "y", score: 50 }],
      },
    });
    expect(p.isResult).toBe(true);
  });
});
