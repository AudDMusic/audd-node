import { describe, expect, it } from "vitest";
import {
  parseEnterpriseChunkResult,
  parseEnterpriseMatch,
  parseLyricsResult,
  parseRecognitionResult,
  parseStream,
  parseStreamCallback,
} from "../src/models.js";

describe("models — RecognitionResult", () => {
  it("parses a public-catalog match", () => {
    const r = parseRecognitionResult({
      artist: "Tears For Fears",
      title: "Everybody Wants To Rule The World",
      timecode: "00:56",
      song_link: "https://lis.tn/NbkVb",
    });
    expect(r.artist).toBe("Tears For Fears");
    expect(r.title).toBe("Everybody Wants To Rule The World");
    expect(r.timecode).toBe("00:56");
    expect(r.isPublicMatch).toBe(true);
    expect(r.isCustomMatch).toBe(false);
    expect(r.thumbnailUrl).toBe("https://lis.tn/NbkVb?thumb");
  });

  it("parses a custom-catalog match (audio_id, no artist)", () => {
    const r = parseRecognitionResult({ timecode: "01:45", audio_id: 146 });
    expect(r.audioId).toBe(146);
    expect(r.isCustomMatch).toBe(true);
    expect(r.isPublicMatch).toBe(false);
    expect(r.thumbnailUrl).toBeNull();
  });

  it("thumbnailUrl is null for non-lis.tn song_link (e.g., youtube)", () => {
    const r = parseRecognitionResult({
      artist: "x",
      title: "y",
      timecode: "00:01",
      song_link: "https://youtube.com/watch?v=abc",
    });
    expect(r.thumbnailUrl).toBeNull();
  });

  it("thumbnailUrl uses & if song_link already has query string", () => {
    const r = parseRecognitionResult({
      artist: "x",
      title: "y",
      timecode: "00:01",
      song_link: "https://lis.tn/NbkVb?utm=1",
    });
    expect(r.thumbnailUrl).toBe("https://lis.tn/NbkVb?utm=1&thumb");
  });

  it("captures unknown fields in extras", () => {
    const r = parseRecognitionResult({
      timecode: "00:56",
      artist: "x",
      title: "y",
      tidal: { id: 99 },
      newField: "future",
    });
    expect(r.extras).toEqual({ tidal: { id: 99 }, newField: "future" });
    expect(r.artist).toBe("x");
  });

  it("appleMusic and spotify pass through as records", () => {
    const r = parseRecognitionResult({
      timecode: "00:56",
      artist: "x",
      title: "y",
      apple_music: { url: "https://music.apple.com/...", isrc: "GBUM71403885" },
      spotify: { id: "abc", name: "song" },
    });
    expect(r.appleMusic?.url).toBe("https://music.apple.com/...");
    expect(r.spotify?.id).toBe("abc");
  });

  it("missing timecode raises", () => {
    expect(() => parseRecognitionResult({ artist: "x" })).toThrowError(/timecode/);
  });

  it("non-object raises", () => {
    expect(() => parseRecognitionResult("foo")).toThrow();
    expect(() => parseRecognitionResult(null)).toThrow();
  });
});

describe("models — EnterpriseMatch", () => {
  it("parses isrc/upc fields", () => {
    const m = parseEnterpriseMatch({
      score: 81,
      timecode: "00:57",
      artist: "Tears For Fears",
      title: "Everybody Wants To Rule The World",
      isrc: "GBUM71403885",
      upc: "00602547037169",
      song_link: "https://lis.tn/NbkVb",
    });
    expect(m.score).toBe(81);
    expect(m.isrc).toBe("GBUM71403885");
    expect(m.upc).toBe("00602547037169");
    expect(m.thumbnailUrl).toBe("https://lis.tn/NbkVb?thumb");
  });

  it("extras pass through", () => {
    const m = parseEnterpriseMatch({
      score: 50,
      timecode: "00:01",
      newKey: "newVal",
    });
    expect(m.extras).toEqual({ newKey: "newVal" });
  });

  it("EnterpriseChunkResult contains a list of matches and offset", () => {
    const c = parseEnterpriseChunkResult({
      songs: [{ score: 50, timecode: "00:01" }],
      offset: "00:00",
    });
    expect(c.songs).toHaveLength(1);
    expect(c.songs[0]?.score).toBe(50);
    expect(c.offset).toBe("00:00");
  });
});

describe("models — Stream", () => {
  it("parses a getStreams entry", () => {
    const s = parseStream({
      radio_id: 7,
      url: "https://example.stream/live.mp3",
      stream_running: true,
      longpoll_category: "abc123def",
    });
    expect(s.radioId).toBe(7);
    expect(s.url).toBe("https://example.stream/live.mp3");
    expect(s.streamRunning).toBe(true);
    expect(s.longpollCategory).toBe("abc123def");
  });
});

describe("models — StreamCallback", () => {
  it("parses a result-shaped callback", () => {
    const p = parseStreamCallback({
      status: "success",
      result: {
        radio_id: 7,
        timestamp: "2020-04-13 10:31:43",
        play_length: 111,
        results: [
          {
            artist: "Alan Walker, A$AP Rocky",
            title: "Live Fast (PUBGM)",
            score: 100,
            song_link: "https://lis.tn/LiveFastPUBGM",
          },
        ],
      },
    });
    expect(p.isResult).toBe(true);
    expect(p.isNotification).toBe(false);
    expect(p.result?.radioId).toBe(7);
    expect(p.result?.results[0]?.artist).toBe("Alan Walker, A$AP Rocky");
  });

  it("parses a notification-shaped callback", () => {
    const p = parseStreamCallback({
      status: "-",
      notification: {
        radio_id: 3,
        stream_running: false,
        notification_code: 650,
        notification_message: "Recognition failed: can't connect",
      },
      time: 1587939136,
    });
    expect(p.isNotification).toBe(true);
    expect(p.isResult).toBe(false);
    expect(p.notification?.notificationCode).toBe(650);
    expect(p.notification?.streamRunning).toBe(false);
    expect(p.time).toBe(1587939136);
  });
});

describe("models — LyricsResult", () => {
  it("parses minimum fields", () => {
    const l = parseLyricsResult({ artist: "x", title: "y" });
    expect(l.artist).toBe("x");
    expect(l.title).toBe("y");
  });

  it("captures extras", () => {
    const l = parseLyricsResult({
      artist: "a",
      title: "t",
      lyrics: "la la",
      newField: "val",
    });
    expect(l.lyrics).toBe("la la");
    expect(l.extras).toEqual({ newField: "val" });
  });
});
