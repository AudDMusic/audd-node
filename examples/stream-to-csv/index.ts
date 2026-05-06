/**
 * Subscribe to a live audio stream and append every recognition to a CSV.
 *
 * Usage:
 *   AUDD_API_TOKEN=... npx tsx index.ts "https://stream.example/live.m3u8" \
 *     --output recordings.csv --radio-id 99999
 *
 * Lifecycle:
 *   1. checks the account's callback URL (longpoll silently dead-ends without one)
 *   2. registers https://audd.tech/empty/ if none was set, leaves an existing one alone
 *   3. adds the stream and longpolls its category
 *   4. SIGINT/SIGTERM: deletes the stream, restores callback if we set one
 *
 * Notification envelopes go to console.warn, not the CSV.
 */
import { createWriteStream, type WriteStream } from "node:fs";
import { AudD, AudDAPIError } from "../../src/index.js";

interface Args {
  url: string;
  output: string;
  radioId: number;
}

function parseArgs(argv: readonly string[]): Args {
  let url: string | undefined;
  let output = "recordings.csv";
  let radioId: number | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--output") {
      const v = argv[i + 1];
      if (v === undefined) throw new Error("--output needs a value");
      output = v;
      i++;
    } else if (a === "--radio-id") {
      const v = argv[i + 1];
      if (v === undefined) throw new Error("--radio-id needs a value");
      const n = Number.parseInt(v, 10);
      if (!Number.isFinite(n)) throw new Error(`--radio-id must be an integer, got ${v}`);
      radioId = n;
      i++;
    } else if (a !== undefined && !a.startsWith("--") && url === undefined) {
      url = a;
    } else {
      throw new Error(`unexpected argument: ${String(a)}`);
    }
  }
  if (url === undefined) throw new Error("missing stream URL");
  if (radioId === undefined) throw new Error("missing --radio-id");
  return { url, output, radioId };
}

const PLACEHOLDER_CALLBACK = "https://audd.tech/empty/";
/** Server signals "no callback URL configured" with code 19. */
const NO_CALLBACK_ERROR_CODE = 19;

function csvField(v: unknown): string {
  if (v === null || v === undefined) return "";
  const s = String(v);
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function row(values: readonly unknown[]): string {
  return values.map(csvField).join(",") + "\n";
}

async function getExistingCallback(audd: AudD): Promise<string | null> {
  try {
    const url = await audd.streams.getCallbackUrl();
    return url === "" ? null : url;
  } catch (err) {
    if (err instanceof AudDAPIError && err.errorCode === NO_CALLBACK_ERROR_CODE) {
      return null;
    }
    throw err;
  }
}

async function main(): Promise<void> {
  let args: Args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    console.error(
      "usage: index.ts <stream-url> --radio-id <id> [--output recordings.csv]",
    );
    process.exit(2);
  }

  const audd = new AudD();

  const existingCallback = await getExistingCallback(audd);
  let weSetTheCallback = false;
  if (existingCallback === null) {
    console.warn(`no callback URL set on this account; registering ${PLACEHOLDER_CALLBACK}`);
    await audd.streams.setCallbackUrl(PLACEHOLDER_CALLBACK);
    weSetTheCallback = true;
  } else {
    console.warn(`leaving existing callback URL in place: ${existingCallback}`);
  }

  await audd.streams.add({ url: args.url, radioId: args.radioId });
  console.warn(`added stream radio_id=${String(args.radioId)} -> ${args.url}`);

  const csv: WriteStream = createWriteStream(args.output, { flags: "a" });
  csv.write(row(["timestamp", "radio_id", "score", "artist", "title", "album", "song_link"]));

  const ac = new AbortController();
  let cleanedUp = false;
  const cleanup = async (signal: string): Promise<void> => {
    if (cleanedUp) return;
    cleanedUp = true;
    console.warn(`\n${signal} received; cleaning up`);
    ac.abort();
    csv.end();
    try {
      await audd.streams.delete(args.radioId);
      console.warn(`deleted stream radio_id=${String(args.radioId)}`);
    } catch (err) {
      console.warn(`stream delete failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (weSetTheCallback) {
      // The AudD API has setCallbackUrl but no clearCallbackUrl; once we
      // registered the placeholder we can't undo that. Surfacing it in
      // stderr so the operator can replace it manually if needed.
      console.warn(
        `callback URL left at ${PLACEHOLDER_CALLBACK}; the AudD API has no ` +
          "clear-callback method, overwrite it via streams.setCallbackUrl(...)",
      );
    } else {
      console.warn("left the existing callback URL untouched");
    }
    process.exit(0);
  };
  process.on("SIGINT", () => {
    void cleanup("SIGINT");
  });
  process.on("SIGTERM", () => {
    void cleanup("SIGTERM");
  });

  const category = audd.streams.deriveLongpollCategory(args.radioId);
  console.warn(`longpolling category=${category}; press Ctrl+C to stop`);

  const poll = await audd.streams.longpoll(category, { timeout: 50 });
  ac.signal.addEventListener("abort", () => poll.close(), { once: true });

  await Promise.all([
    (async () => {
      for await (const m of poll.matches) {
        // The top match plus any variant releases (different artist/title is
        // possible — alternatives are catalog variants, not lower-confidence
        // guesses at the same recording).
        for (const song of [m.song, ...m.alternatives]) {
          csv.write(
            row([
              m.timestamp ?? "",
              m.radioId,
              song.score,
              song.artist,
              song.title,
              song.album ?? "",
              song.songLink ?? "",
            ]),
          );
          console.log(
            `${m.timestamp ?? "?"}  ${song.artist} - ${song.title}  (score=${String(song.score)})`,
          );
        }
      }
    })(),
    (async () => {
      for await (const n of poll.notifications) {
        console.warn(
          `notification radio=${String(n.radioId)} #${String(n.notificationCode)} ${n.notificationMessage}`,
        );
      }
    })(),
    (async () => {
      for await (const err of poll.errors) {
        console.warn(`longpoll error: ${err.message}`);
        poll.close();
      }
    })(),
  ]);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
