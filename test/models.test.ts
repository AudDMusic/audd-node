import { describe, expect, it } from "vitest";
import {
  parseEnterpriseChunkResult,
  parseEnterpriseMatch,
  parseLyricsResult,
  parseRecognitionResult,
  parseStream,
  parseStreamCallbackMatch,
  parseStreamCallbackNotification,
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

  it("tolerates a missing timecode", () => {
    const r = parseRecognitionResult({ artist: "x" });
    expect(r.timecode).toBeUndefined();
    expect(r.artist).toBe("x");
  });

  it("non-object raises", () => {
    expect(() => parseRecognitionResult("foo")).toThrow();
    expect(() => parseRecognitionResult(null)).toThrow();
  });
});

describe("models — EnterpriseMatch", () => {
  it("tolerates a missing score (the endpoint can omit it)", () => {
    const m = parseEnterpriseMatch({
      timecode: "00:31",
      artist: "Imagine Dragons",
      title: "Warriors",
    });
    expect(m.score).toBeUndefined();
    expect(m.artist).toBe("Imagine Dragons");
    expect(m.title).toBe("Warriors");
  });

  it("tolerates an all-but-empty match without throwing", () => {
    const m = parseEnterpriseMatch({});
    expect(m.score).toBeUndefined();
    expect(m.timecode).toBeUndefined();
    expect(m.artist).toBeUndefined();
  });

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

describe("models — StreamCallbackMatch", () => {
  it("parses a result block with one song", () => {
    const m = parseStreamCallbackMatch({
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
    });
    expect(m.radioId).toBe(7);
    expect(m.timestamp).toBe("2020-04-13 10:31:43");
    expect(m.playLength).toBe(111);
    expect(m.song.artist).toBe("Alan Walker, A$AP Rocky");
    expect(m.song.title).toBe("Live Fast (PUBGM)");
    expect(m.alternatives).toEqual([]);
  });

  it("splits multiple results into song + alternatives", () => {
    const m = parseStreamCallbackMatch({
      radio_id: 9,
      timestamp: "x",
      results: [
        { artist: "A", title: "T", score: 100 },
        { artist: "A2", title: "T2", score: 80 },
      ],
    });
    expect(m.song.artist).toBe("A");
    expect(m.alternatives).toHaveLength(1);
    expect(m.alternatives[0]?.artist).toBe("A2");
  });

  it("tolerates empty results", () => {
    const m = parseStreamCallbackMatch({ radio_id: 1, results: [] });
    expect(m.song).toBeUndefined();
    expect(m.alternatives).toHaveLength(0);
  });

  it("captures isrc/upc on the song", () => {
    const m = parseStreamCallbackMatch({
      radio_id: 1,
      results: [
        {
          artist: "A",
          title: "T",
          score: 100,
          isrc: "GBUM71403885",
          upc: "00602547037169",
        },
      ],
    });
    expect(m.song.isrc).toBe("GBUM71403885");
    expect(m.song.upc).toBe("00602547037169");
  });
});

describe("models — StreamCallbackNotification", () => {
  it("parses a notification block", () => {
    const n = parseStreamCallbackNotification({
      radio_id: 3,
      stream_running: false,
      notification_code: 650,
      notification_message: "Recognition failed: can't connect",
    });
    expect(n.radioId).toBe(3);
    expect(n.streamRunning).toBe(false);
    expect(n.notificationCode).toBe(650);
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
