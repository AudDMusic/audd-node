import { describe, expect, it } from "vitest";

import { parseRecognitionResult, type RecognitionResult } from "../src/models.js";

function mkResult(songLink?: string, extras: Record<string, unknown> = {}): RecognitionResult {
  const raw: Record<string, unknown> = { timecode: "00:01" };
  if (songLink !== undefined) raw["song_link"] = songLink;
  Object.assign(raw, extras);
  return parseRecognitionResult(raw);
}

describe("streaming helpers", () => {
  it("streamingUrl returns lis.tn redirect for lis.tn song_link", () => {
    const r = mkResult("https://lis.tn/abc");
    expect(r.streamingUrl("spotify")).toBe("https://lis.tn/abc?spotify");
    expect(r.streamingUrl("apple_music")).toBe("https://lis.tn/abc?apple_music");
    expect(r.streamingUrl("youtube")).toBe("https://lis.tn/abc?youtube");
  });

  it("streamingUrl returns null for YouTube song_link with no metadata", () => {
    const r = mkResult("https://www.youtube.com/watch?v=x");
    expect(r.streamingUrl("spotify")).toBeNull();
  });

  it("streamingUrl falls back to apple_music.url for non-lis.tn song_link", () => {
    const r = mkResult("https://www.youtube.com/watch?v=x", {
      apple_music: { url: "https://music.apple.com/us/album/x/123" },
    });
    expect(r.streamingUrl("apple_music")).toBe("https://music.apple.com/us/album/x/123");
  });

  it("streamingUrl falls back to spotify.external_urls.spotify", () => {
    const r = mkResult("https://www.youtube.com/watch?v=x", {
      spotify: { external_urls: { spotify: "https://open.spotify.com/track/abc" } },
    });
    expect(r.streamingUrl("spotify")).toBe("https://open.spotify.com/track/abc");
  });

  it("streamingUrl falls back to deezer.link", () => {
    const r = mkResult("https://www.youtube.com/watch?v=x", {
      deezer: { link: "https://www.deezer.com/track/123" },
    });
    expect(r.streamingUrl("deezer")).toBe("https://www.deezer.com/track/123");
  });

  it("streamingUrl prefers direct URL over lis.tn redirect", () => {
    const r = mkResult("https://lis.tn/abc", {
      apple_music: { url: "https://music.apple.com/us/album/x/123" },
    });
    expect(r.streamingUrl("apple_music")).toBe("https://music.apple.com/us/album/x/123");
  });

  it("streamingUrl throws on unknown provider", () => {
    const r = mkResult("https://lis.tn/abc");
    expect(() => r.streamingUrl("tidal" as never)).toThrow();
  });

  it("streamingUrls returns the union of metadata + lis.tn paths", () => {
    const r = mkResult("https://www.youtube.com/watch?v=x", {
      apple_music: { url: "https://music.apple.com/us/album/x/123" },
      deezer: { link: "https://www.deezer.com/track/123" },
    });
    const urls = r.streamingUrls();
    expect(urls.apple_music).toBe("https://music.apple.com/us/album/x/123");
    expect(urls.deezer).toBe("https://www.deezer.com/track/123");
    expect(urls.spotify).toBeUndefined();
    expect(urls.youtube).toBeUndefined();
  });

  it("previewUrl picks apple_music first", () => {
    const r = mkResult(undefined, {
      apple_music: { previews: [{ url: "https://itunes/preview.m4a" }] },
      spotify: { preview_url: "https://spotify/preview.mp3" },
    });
    expect(r.previewUrl()).toBe("https://itunes/preview.m4a");
  });

  it("previewUrl falls back to spotify, then deezer", () => {
    expect(
      mkResult(undefined, { spotify: { preview_url: "https://spotify/p.mp3" } }).previewUrl(),
    ).toBe("https://spotify/p.mp3");
    expect(
      mkResult(undefined, { deezer: { preview: "https://deezer/p.mp3" } }).previewUrl(),
    ).toBe("https://deezer/p.mp3");
  });

  it("previewUrl returns null when no metadata block has a preview", () => {
    expect(mkResult().previewUrl()).toBeNull();
  });
});
