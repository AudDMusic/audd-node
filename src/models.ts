/**
 * Typed models. Forward-compatible: each model captures unknown keys into
 * `extras`, mirroring audd-python's Pydantic `extra="allow"` pattern.
 */

function pickExtras(
  raw: Record<string, unknown>,
  knownKeys: ReadonlyArray<string>,
): Record<string, unknown> {
  const known = new Set(knownKeys);
  const extras: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (!known.has(k)) extras[k] = v;
  }
  return extras;
}

function asObject(raw: unknown): Record<string, unknown> | undefined {
  if (typeof raw === "object" && raw !== null && !Array.isArray(raw)) {
    return raw as Record<string, unknown>;
  }
  return undefined;
}

function requireObject(raw: unknown, what: string): Record<string, unknown> {
  const o = asObject(raw);
  if (o === undefined) throw new TypeError(`${what}: expected object`);
  return o;
}

function asString(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}
function asNumber(v: unknown): number | undefined {
  return typeof v === "number" ? v : undefined;
}
function asBoolean(v: unknown): boolean | undefined {
  return typeof v === "boolean" ? v : undefined;
}

/** Streaming providers supported by the lis.tn redirect helper. */
export type StreamingProvider =
  | "spotify"
  | "apple_music"
  | "deezer"
  | "napster"
  | "youtube";

const STREAMING_PROVIDERS: readonly StreamingProvider[] = [
  "spotify",
  "apple_music",
  "deezer",
  "napster",
  "youtube",
] as const;

function lisTnStreamingUrl(songLink: string | undefined, provider: string): string | null {
  if (songLink === undefined || songLink === "") return null;
  let parsed: URL;
  try {
    parsed = new URL(songLink);
  } catch {
    return null;
  }
  if (parsed.hostname !== "lis.tn") return null;
  const sep = parsed.search ? "&" : "?";
  return `${songLink}${sep}${provider}`;
}

export interface RecognitionResult {
  /** Always present on a match. */
  timecode: string;
  /** Set on custom-catalog matches. */
  audioId?: number | undefined;
  artist?: string | undefined;
  title?: string | undefined;
  album?: string | undefined;
  releaseDate?: string | undefined;
  label?: string | undefined;
  songLink?: string | undefined;
  appleMusic?: Record<string, unknown> | undefined;
  spotify?: Record<string, unknown> | undefined;
  deezer?: Record<string, unknown> | undefined;
  napster?: Record<string, unknown> | undefined;
  musicbrainz?: ReadonlyArray<Record<string, unknown>> | undefined;
  /** Forward-compat: any unknown keys from the server. */
  extras: Record<string, unknown>;
  /** Full unparsed payload for the caller's own inspection. */
  rawResponse: Record<string, unknown>;
  /** True when `audioId` is set (custom-catalog match). */
  readonly isCustomMatch: boolean;
  /** True when `audioId` is unset and `artist` or `title` are present. */
  readonly isPublicMatch: boolean;
  /** Cover-art URL for `lis.tn`-hosted song_links, else `null`. */
  readonly thumbnailUrl: string | null;
  /**
   * Direct or redirect URL for a streaming provider, with smart fallback.
   *
   * Resolution order:
   * 1. Direct URL from the metadata block (e.g. `apple_music.url`,
   *    `spotify.external_urls.spotify`, `deezer.link`, `napster.href`) when
   *    the user requested that provider via `return=`.
   * 2. lis.tn redirect (`{songLink}?{provider}`) when `songLink` is on lis.tn.
   * 3. `null` otherwise. YouTube has only the lis.tn-redirect path.
   */
  streamingUrl(provider: StreamingProvider): string | null;
  /** Map of every provider with a resolvable URL — direct or via lis.tn redirect. */
  streamingUrls(): Partial<Record<StreamingProvider, string>>;
  /**
   * First available 30-second preview URL across providers, in priority order:
   * `apple_music.previews[0].url` → `spotify.preview_url` → `deezer.preview`.
   *
   * **Note:** previews are governed by the respective providers' terms of use.
   * The SDK consumer is responsible for honoring those terms (caching limits,
   * attribution, redistribution constraints).
   */
  previewUrl(): string | null;
}

function directStreamingUrl(
  result: Pick<RecognitionResult, "appleMusic" | "spotify" | "deezer" | "napster">,
  provider: string,
): string | null {
  if (provider === "apple_music" && result.appleMusic !== undefined) {
    const url = result.appleMusic["url"];
    if (typeof url === "string" && url.length > 0) return url;
  } else if (provider === "spotify" && result.spotify !== undefined) {
    const ext = result.spotify["external_urls"];
    if (typeof ext === "object" && ext !== null) {
      const sp = (ext as Record<string, unknown>)["spotify"];
      if (typeof sp === "string" && sp.length > 0) return sp;
    }
    const uri = result.spotify["uri"];
    if (typeof uri === "string" && uri.length > 0) return uri;
  } else if (provider === "deezer" && result.deezer !== undefined) {
    const link = result.deezer["link"];
    if (typeof link === "string" && link.length > 0) return link;
  } else if (provider === "napster" && result.napster !== undefined) {
    const href = result.napster["href"];
    if (typeof href === "string" && href.length > 0) return href;
  }
  return null;
}

function previewFrom(result: Pick<RecognitionResult, "appleMusic" | "spotify" | "deezer">): string | null {
  if (result.appleMusic !== undefined) {
    const previews = result.appleMusic["previews"];
    if (Array.isArray(previews) && previews.length > 0) {
      const first = previews[0];
      if (typeof first === "object" && first !== null) {
        const url = (first as Record<string, unknown>)["url"];
        if (typeof url === "string" && url.length > 0) return url;
      }
    }
  }
  if (result.spotify !== undefined) {
    const url = result.spotify["preview_url"];
    if (typeof url === "string" && url.length > 0) return url;
  }
  if (result.deezer !== undefined) {
    const url = result.deezer["preview"];
    if (typeof url === "string" && url.length > 0) return url;
  }
  return null;
}

const RECOGNITION_KEYS = [
  "timecode",
  "audio_id",
  "artist",
  "title",
  "album",
  "release_date",
  "label",
  "song_link",
  "apple_music",
  "spotify",
  "deezer",
  "napster",
  "musicbrainz",
] as const;

export function parseRecognitionResult(raw: unknown): RecognitionResult {
  const r = requireObject(raw, "RecognitionResult");
  const timecode = asString(r.timecode);
  if (timecode === undefined) {
    throw new TypeError("RecognitionResult: timecode missing or not string");
  }
  const audioId = asNumber(r.audio_id);
  const artist = asString(r.artist);
  const title = asString(r.title);
  const songLink = asString(r.song_link);
  const musicbrainz = Array.isArray(r.musicbrainz)
    ? (r.musicbrainz.filter((x): x is Record<string, unknown> => asObject(x) !== undefined) as
        | Record<string, unknown>[]
        | undefined)
    : undefined;

  const result: RecognitionResult = {
    timecode,
    audioId,
    artist,
    title,
    album: asString(r.album),
    releaseDate: asString(r.release_date),
    label: asString(r.label),
    songLink,
    appleMusic: asObject(r.apple_music),
    spotify: asObject(r.spotify),
    deezer: asObject(r.deezer),
    napster: asObject(r.napster),
    musicbrainz,
    extras: pickExtras(r, RECOGNITION_KEYS),
    rawResponse: r,
    get isCustomMatch() {
      return audioId !== undefined;
    },
    get isPublicMatch() {
      return audioId === undefined && (artist !== undefined || title !== undefined);
    },
    get thumbnailUrl() {
      return lisTnStreamingUrl(songLink, "thumb");
    },
    streamingUrl(provider: StreamingProvider): string | null {
      if (!STREAMING_PROVIDERS.includes(provider)) {
        throw new TypeError(
          `Unknown streaming provider: ${String(provider)}. ` +
            `Valid: ${STREAMING_PROVIDERS.join(", ")}`,
        );
      }
      const direct = directStreamingUrl(result, provider);
      if (direct !== null) return direct;
      return lisTnStreamingUrl(songLink, provider);
    },
    streamingUrls(): Partial<Record<StreamingProvider, string>> {
      const out: Partial<Record<StreamingProvider, string>> = {};
      for (const p of STREAMING_PROVIDERS) {
        const url = result.streamingUrl(p);
        if (url !== null) out[p] = url;
      }
      return out;
    },
    previewUrl(): string | null {
      return previewFrom(result);
    },
  };
  return result;
}

export interface EnterpriseMatch {
  score: number;
  timecode: string;
  artist?: string | undefined;
  title?: string | undefined;
  album?: string | undefined;
  releaseDate?: string | undefined;
  label?: string | undefined;
  isrc?: string | undefined;
  upc?: string | undefined;
  songLink?: string | undefined;
  startOffset?: number | undefined;
  endOffset?: number | undefined;
  extras: Record<string, unknown>;
  rawResponse: Record<string, unknown>;
  readonly thumbnailUrl: string | null;
  /** lis.tn redirect URL for the given streaming provider, or null if `songLink` is non-lis.tn. */
  streamingUrl(provider: StreamingProvider): string | null;
  /** All providers with a resolvable lis.tn redirect URL (or empty when `songLink` is off lis.tn). */
  streamingUrls(): Partial<Record<StreamingProvider, string>>;
}

const ENTERPRISE_MATCH_KEYS = [
  "score",
  "timecode",
  "artist",
  "title",
  "album",
  "release_date",
  "label",
  "isrc",
  "upc",
  "song_link",
  "start_offset",
  "end_offset",
] as const;

export function parseEnterpriseMatch(raw: unknown): EnterpriseMatch {
  const r = requireObject(raw, "EnterpriseMatch");
  const score = asNumber(r.score);
  const timecode = asString(r.timecode);
  if (score === undefined) throw new TypeError("EnterpriseMatch: score not number");
  if (timecode === undefined) throw new TypeError("EnterpriseMatch: timecode not string");
  const songLink = asString(r.song_link);
  return {
    score,
    timecode,
    artist: asString(r.artist),
    title: asString(r.title),
    album: asString(r.album),
    releaseDate: asString(r.release_date),
    label: asString(r.label),
    isrc: asString(r.isrc),
    upc: asString(r.upc),
    songLink,
    startOffset: asNumber(r.start_offset),
    endOffset: asNumber(r.end_offset),
    extras: pickExtras(r, ENTERPRISE_MATCH_KEYS),
    rawResponse: r,
    streamingUrl(provider: StreamingProvider): string | null {
      if (!STREAMING_PROVIDERS.includes(provider)) {
        throw new TypeError(`Unknown streaming provider: ${String(provider)}`);
      }
      return lisTnStreamingUrl(songLink, provider);
    },
    streamingUrls(): Partial<Record<StreamingProvider, string>> {
      const out: Partial<Record<StreamingProvider, string>> = {};
      for (const p of STREAMING_PROVIDERS) {
        const url = lisTnStreamingUrl(songLink, p);
        if (url !== null) out[p] = url;
      }
      return out;
    },
    get thumbnailUrl() {
      if (songLink === undefined || songLink === "") return null;
      try {
        const parsed = new URL(songLink);
        if (parsed.hostname !== "lis.tn") return null;
        const sep = parsed.search ? "&" : "?";
        return `${songLink}${sep}thumb`;
      } catch {
        return null;
      }
    },
  };
}

export interface EnterpriseChunkResult {
  songs: EnterpriseMatch[];
  offset: string;
  extras: Record<string, unknown>;
  rawResponse: Record<string, unknown>;
}

const ENTERPRISE_CHUNK_KEYS = ["songs", "offset"] as const;

export function parseEnterpriseChunkResult(raw: unknown): EnterpriseChunkResult {
  const r = requireObject(raw, "EnterpriseChunkResult");
  const songsRaw = r.songs;
  if (!Array.isArray(songsRaw)) {
    throw new TypeError("EnterpriseChunkResult: songs not array");
  }
  const offset = asString(r.offset);
  if (offset === undefined) throw new TypeError("EnterpriseChunkResult: offset not string");
  return {
    songs: songsRaw.map(parseEnterpriseMatch),
    offset,
    extras: pickExtras(r, ENTERPRISE_CHUNK_KEYS),
    rawResponse: r,
  };
}

export interface Stream {
  radioId: number;
  url: string;
  streamRunning: boolean;
  longpollCategory?: string | undefined;
  extras: Record<string, unknown>;
  rawResponse: Record<string, unknown>;
}

const STREAM_KEYS = ["radio_id", "url", "stream_running", "longpoll_category"] as const;

export function parseStream(raw: unknown): Stream {
  const r = requireObject(raw, "Stream");
  const radioId = asNumber(r.radio_id);
  const url = asString(r.url);
  const streamRunning = asBoolean(r.stream_running);
  if (radioId === undefined) throw new TypeError("Stream: radio_id not number");
  if (url === undefined) throw new TypeError("Stream: url not string");
  if (streamRunning === undefined) throw new TypeError("Stream: stream_running not boolean");
  return {
    radioId,
    url,
    streamRunning,
    longpollCategory: asString(r.longpoll_category),
    extras: pickExtras(r, STREAM_KEYS),
    rawResponse: r,
  };
}

export interface StreamCallbackResultEntry {
  artist: string;
  title: string;
  score: number;
  album?: string | undefined;
  releaseDate?: string | undefined;
  label?: string | undefined;
  songLink?: string | undefined;
  appleMusic?: Record<string, unknown> | undefined;
  spotify?: Record<string, unknown> | undefined;
  deezer?: Record<string, unknown> | undefined;
  napster?: Record<string, unknown> | undefined;
  musicbrainz?: ReadonlyArray<Record<string, unknown>> | undefined;
  extras: Record<string, unknown>;
  rawResponse: Record<string, unknown>;
}

const STREAM_CALLBACK_RESULT_ENTRY_KEYS = [
  "artist",
  "title",
  "score",
  "album",
  "release_date",
  "label",
  "song_link",
  "apple_music",
  "spotify",
  "deezer",
  "napster",
  "musicbrainz",
] as const;

export function parseStreamCallbackResultEntry(raw: unknown): StreamCallbackResultEntry {
  const r = requireObject(raw, "StreamCallbackResultEntry");
  const artist = asString(r.artist);
  const title = asString(r.title);
  const score = asNumber(r.score);
  if (artist === undefined) throw new TypeError("StreamCallbackResultEntry: artist not string");
  if (title === undefined) throw new TypeError("StreamCallbackResultEntry: title not string");
  if (score === undefined) throw new TypeError("StreamCallbackResultEntry: score not number");
  const musicbrainz = Array.isArray(r.musicbrainz)
    ? (r.musicbrainz.filter((x): x is Record<string, unknown> => asObject(x) !== undefined) as
        | Record<string, unknown>[]
        | undefined)
    : undefined;
  return {
    artist,
    title,
    score,
    album: asString(r.album),
    releaseDate: asString(r.release_date),
    label: asString(r.label),
    songLink: asString(r.song_link),
    appleMusic: asObject(r.apple_music),
    spotify: asObject(r.spotify),
    deezer: asObject(r.deezer),
    napster: asObject(r.napster),
    musicbrainz,
    extras: pickExtras(r, STREAM_CALLBACK_RESULT_ENTRY_KEYS),
    rawResponse: r,
  };
}

export interface StreamCallbackResult {
  radioId: number;
  timestamp?: string | undefined;
  playLength?: number | undefined;
  results: StreamCallbackResultEntry[];
  extras: Record<string, unknown>;
  rawResponse: Record<string, unknown>;
}

const STREAM_CALLBACK_RESULT_KEYS = [
  "radio_id",
  "timestamp",
  "play_length",
  "results",
] as const;

export function parseStreamCallbackResult(raw: unknown): StreamCallbackResult {
  const r = requireObject(raw, "StreamCallbackResult");
  const radioId = asNumber(r.radio_id);
  if (radioId === undefined) throw new TypeError("StreamCallbackResult: radio_id not number");
  const resultsRaw = r.results;
  if (!Array.isArray(resultsRaw)) throw new TypeError("StreamCallbackResult: results not array");
  return {
    radioId,
    timestamp: asString(r.timestamp),
    playLength: asNumber(r.play_length),
    results: resultsRaw.map(parseStreamCallbackResultEntry),
    extras: pickExtras(r, STREAM_CALLBACK_RESULT_KEYS),
    rawResponse: r,
  };
}

export interface StreamCallbackNotification {
  radioId: number;
  streamRunning?: boolean | undefined;
  notificationCode: number;
  notificationMessage: string;
  extras: Record<string, unknown>;
  rawResponse: Record<string, unknown>;
}

const STREAM_CALLBACK_NOTIFICATION_KEYS = [
  "radio_id",
  "stream_running",
  "notification_code",
  "notification_message",
] as const;

export function parseStreamCallbackNotification(raw: unknown): StreamCallbackNotification {
  const r = requireObject(raw, "StreamCallbackNotification");
  const radioId = asNumber(r.radio_id);
  if (radioId === undefined)
    throw new TypeError("StreamCallbackNotification: radio_id not number");
  const code = asNumber(r.notification_code);
  if (code === undefined)
    throw new TypeError("StreamCallbackNotification: notification_code not number");
  const message = asString(r.notification_message);
  if (message === undefined)
    throw new TypeError("StreamCallbackNotification: notification_message not string");
  return {
    radioId,
    streamRunning: asBoolean(r.stream_running),
    notificationCode: code,
    notificationMessage: message,
    extras: pickExtras(r, STREAM_CALLBACK_NOTIFICATION_KEYS),
    rawResponse: r,
  };
}

/**
 * Discriminated union: a parsed callback payload is either a recognition
 * result or a notification.
 */
export interface StreamCallbackPayload {
  /** Set when this is a recognition result delivery. */
  result: StreamCallbackResult | null;
  /** Set when this is a stream-state notification. */
  notification: StreamCallbackNotification | null;
  /** Notification time (epoch seconds). */
  time: number | null;
  /** Original parsed JSON body. */
  rawPayload: Record<string, unknown>;
  readonly isResult: boolean;
  readonly isNotification: boolean;
}

export function parseStreamCallback(raw: unknown): StreamCallbackPayload {
  const r = requireObject(raw, "StreamCallbackPayload");
  if ("notification" in r) {
    const notification = parseStreamCallbackNotification(r.notification);
    const time = asNumber(r.time) ?? null;
    return {
      result: null,
      notification,
      time,
      rawPayload: r,
      get isResult() {
        return false;
      },
      get isNotification() {
        return true;
      },
    };
  }
  const inner = requireObject(r.result, "StreamCallbackPayload.result");
  const result = parseStreamCallbackResult(inner);
  return {
    result,
    notification: null,
    time: null,
    rawPayload: r,
    get isResult() {
      return true;
    },
    get isNotification() {
      return false;
    },
  };
}

export interface LyricsResult {
  artist: string;
  title: string;
  lyrics?: string | undefined;
  songId?: number | undefined;
  fullTitle?: string | undefined;
  artistId?: number | undefined;
  songLink?: string | undefined;
  media?: string | undefined;
  extras: Record<string, unknown>;
  rawResponse: Record<string, unknown>;
}

const LYRICS_KEYS = [
  "artist",
  "title",
  "lyrics",
  "song_id",
  "full_title",
  "artist_id",
  "song_link",
  "media",
] as const;

export function parseLyricsResult(raw: unknown): LyricsResult {
  const r = requireObject(raw, "LyricsResult");
  const artist = asString(r.artist);
  const title = asString(r.title);
  if (artist === undefined) throw new TypeError("LyricsResult: artist not string");
  if (title === undefined) throw new TypeError("LyricsResult: title not string");
  return {
    artist,
    title,
    lyrics: asString(r.lyrics),
    songId: asNumber(r.song_id),
    fullTitle: asString(r.full_title),
    artistId: asNumber(r.artist_id),
    songLink: asString(r.song_link),
    media: asString(r.media),
    extras: pickExtras(r, LYRICS_KEYS),
    rawResponse: r,
  };
}
