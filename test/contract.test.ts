/**
 * Contract tests against the canonical OpenAPI fixture set.
 *
 * Resolves fixtures from `$AUDD_OPENAPI_FIXTURES` (set by CI) or, in
 * dev, falls back to the sibling `audd-openapi/fixtures/` directory.
 *
 * If neither is available — typical for `npm run test` on a fresh
 * checkout without the audd-openapi repo nearby — the entire suite
 * skips gracefully. Contract drift is enforced by the dedicated
 * `contract.yml` CI job, which always sets `AUDD_OPENAPI_FIXTURES`.
 */
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { AudD } from "../src/client.js";
import {
  AudDAuthenticationError,
  AudDBlockedError,
  AudDInvalidRequestError,
  AudDQuotaError,
  AudDSubscriptionError,
} from "../src/errors.js";
import {
  parseEnterpriseChunkResult,
  parseRecognitionResult,
  parseStream,
  parseStreamCallback,
} from "../src/models.js";

function resolveFixturesDir(): string | null {
  const env = process.env["AUDD_OPENAPI_FIXTURES"];
  if (env !== undefined && existsSync(env)) return env;
  // Sibling-dir fallback for dev
  const sibling = resolve(__dirname, "..", "..", "audd-openapi", "fixtures");
  if (existsSync(sibling)) return sibling;
  return null;
}

const FIXTURES_DIR = resolveFixturesDir();
const fixturesAvailable = FIXTURES_DIR !== null;

function loadFixture(name: string): unknown {
  if (FIXTURES_DIR === null) {
    throw new Error("loadFixture called while fixtures dir unresolved");
  }
  const path = join(FIXTURES_DIR, name);
  return JSON.parse(readFileSync(path, "utf8"));
}

describe.skipIf(!fixturesAvailable)("contract: recognize_basic.json", () => {
  it("parses RecognitionResult", () => {
    const fixture = loadFixture("recognize_basic.json") as {
      result: unknown;
    };
    const r = parseRecognitionResult(fixture.result);
    expect(r.artist).toBe("Tears For Fears");
    expect(r.title).toBe("Everybody Wants To Rule The World");
    expect(r.timecode).toBe("00:56");
    expect(r.songLink).toBe("https://lis.tn/NbkVb");
    expect(r.thumbnailUrl).toBe("https://lis.tn/NbkVb?thumb");
    expect(r.isPublicMatch).toBe(true);
    expect(r.isCustomMatch).toBe(false);
  });
});

describe.skipIf(!fixturesAvailable)("contract: recognize_with_metadata.json", () => {
  it("parses with apple_music & musicbrainz blocks", () => {
    const fixture = loadFixture("recognize_with_metadata.json") as {
      result: unknown;
    };
    const r = parseRecognitionResult(fixture.result);
    expect(r.appleMusic).toBeDefined();
    expect(r.appleMusic?.["isrc"]).toBe("GBUM71403885");
    expect(r.musicbrainz).toBeDefined();
  });
});

describe.skipIf(!fixturesAvailable)("contract: recognize_custom_match.json", () => {
  it("parses custom-catalog match (audio_id, no artist/title)", () => {
    const fixture = loadFixture("recognize_custom_match.json") as {
      result: unknown;
    };
    const r = parseRecognitionResult(fixture.result);
    expect(r.audioId).toBe(146);
    expect(r.artist).toBeUndefined();
    expect(r.title).toBeUndefined();
    expect(r.isCustomMatch).toBe(true);
    expect(r.isPublicMatch).toBe(false);
  });
});

describe.skipIf(!fixturesAvailable)("contract: enterprise_with_isrc_upc.json", () => {
  it("parses enterprise chunk with isrc & upc", () => {
    const fixture = loadFixture("enterprise_with_isrc_upc.json") as {
      result: unknown[];
    };
    expect(Array.isArray(fixture.result)).toBe(true);
    const chunk = parseEnterpriseChunkResult(fixture.result[0]);
    expect(chunk.songs).toHaveLength(1);
    const song = chunk.songs[0];
    expect(song?.score).toBe(81);
    expect(song?.isrc).toBe("GBUM71403885");
    expect(song?.upc).toBe("00602547037169");
  });
});

describe.skipIf(!fixturesAvailable)("contract: getStreams_empty.json", () => {
  it("parses empty stream list", () => {
    const fixture = loadFixture("getStreams_empty.json") as { result: unknown[] };
    expect(fixture.result).toEqual([]);
    expect(fixture.result.map(parseStream)).toEqual([]);
  });
});

describe.skipIf(!fixturesAvailable)("contract: streams_callback_with_result.json", () => {
  it("parses to a result-shaped payload", () => {
    const fixture = loadFixture("streams_callback_with_result.json");
    const p = parseStreamCallback(fixture);
    expect(p.isResult).toBe(true);
    expect(p.result?.radioId).toBe(7);
    expect(p.result?.results[0]?.artist).toBe("Alan Walker, A$AP Rocky");
  });
});

describe.skipIf(!fixturesAvailable)("contract: streams_callback_with_notification.json", () => {
  it("parses to a notification-shaped payload", () => {
    const fixture = loadFixture("streams_callback_with_notification.json");
    const p = parseStreamCallback(fixture);
    expect(p.isNotification).toBe(true);
    expect(p.notification?.notificationCode).toBe(650);
    expect(p.notification?.streamRunning).toBe(false);
  });
});

describe.skipIf(!fixturesAvailable)("contract: longpoll_no_events.json", () => {
  it("structure matches what the consumer yields", () => {
    const fixture = loadFixture("longpoll_no_events.json") as Record<string, unknown>;
    expect(typeof fixture["timeout"]).toBe("string");
    expect(typeof fixture["timestamp"]).toBe("number");
  });
});

describe.skipIf(!fixturesAvailable)("contract: error fixtures map to typed exceptions", () => {
  function fakeRespond(body: unknown) {
    const fetchImpl = (async () =>
      new Response(JSON.stringify(body))) as unknown as typeof globalThis.fetch;
    return new AudD({ apiToken: "tk", fetch: fetchImpl });
  }

  it("error_900_invalid_token.json → AudDAuthenticationError", async () => {
    const audd = fakeRespond(loadFixture("error_900_invalid_token.json"));
    await expect(audd.recognize("https://x.mp3")).rejects.toThrow(AudDAuthenticationError);
  });

  it("error_902_stream_limit.json → AudDQuotaError", async () => {
    const audd = fakeRespond(loadFixture("error_902_stream_limit.json"));
    await expect(audd.recognize("https://x.mp3")).rejects.toThrow(AudDQuotaError);
  });

  it("error_904_enterprise_unauthorized.json → AudDSubscriptionError", async () => {
    const audd = fakeRespond(loadFixture("error_904_enterprise_unauthorized.json"));
    await expect(audd.recognize("https://x.mp3")).rejects.toThrow(AudDSubscriptionError);
  });

  it("error_700_no_file.json → AudDInvalidRequestError", async () => {
    const audd = fakeRespond(loadFixture("error_700_no_file.json"));
    await expect(audd.recognize("https://x.mp3")).rejects.toThrow(AudDInvalidRequestError);
  });

  it("error_19_no_callback_url.json → AudDBlockedError (code 19)", async () => {
    const audd = fakeRespond(loadFixture("error_19_no_callback_url.json"));
    // For recognize, code 19 maps to AudDBlockedError.
    await expect(audd.recognize("https://x.mp3")).rejects.toThrow(AudDBlockedError);
  });
});
