/**
 * Scan a folder of audio files, recognize each via AudD, write artist/title
 * (and album/year when present) into the file's tags, then rename the file
 * to "Artist - Title.ext".
 *
 * Default is dry-run -- pass --apply to actually mutate files.
 *
 * Usage:
 *   AUDD_API_TOKEN=... npx tsx index.ts /path/to/folder
 *   AUDD_API_TOKEN=... npx tsx index.ts /path/to/folder --apply --concurrency 8
 *
 * Tag writing currently covers MP3 only (via node-id3). Other formats are
 * recognized and reported but not retagged. See README for extending coverage.
 */
import { readdir, rename, stat } from "node:fs/promises";
import * as path from "node:path";
import NodeID3 from "node-id3";
import pLimit from "p-limit";
import { AudD, type RecognitionResult } from "../../src/index.js";

const AUDIO_EXTS = new Set([
  ".mp3",
  ".flac",
  ".ogg",
  ".opus",
  ".m4a",
  ".mp4",
  ".wav",
  ".aac",
]);

const RETAGGABLE_EXTS = new Set([".mp3"]);

const FS_UNSAFE = /[/\\:*?"<>|]/g;
const MAX_NAME_LEN = 200;

interface Args {
  root: string;
  apply: boolean;
  concurrency: number;
}

function parseArgs(argv: readonly string[]): Args {
  let root: string | undefined;
  let apply = false;
  let concurrency = 4;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--apply") {
      apply = true;
    } else if (a === "--concurrency") {
      const next = argv[i + 1];
      if (next === undefined) throw new Error("--concurrency needs a value");
      const n = Number.parseInt(next, 10);
      if (!Number.isFinite(n) || n < 1) {
        throw new Error(`--concurrency must be a positive integer, got ${next}`);
      }
      concurrency = n;
      i++;
    } else if (a !== undefined && !a.startsWith("--") && root === undefined) {
      root = a;
    } else {
      throw new Error(`unexpected argument: ${String(a)}`);
    }
  }
  if (root === undefined) {
    throw new Error("missing folder argument");
  }
  return { root, apply, concurrency };
}

async function* walk(dir: string): AsyncGenerator<string> {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      yield* walk(full);
    } else if (e.isFile() && AUDIO_EXTS.has(path.extname(e.name).toLowerCase())) {
      yield full;
    }
  }
}

function sanitize(s: string): string {
  return s.replace(FS_UNSAFE, "_").replace(/\s+/g, " ").trim();
}

function targetName(result: RecognitionResult, ext: string): string | null {
  const artist = result.artist;
  const title = result.title;
  if (artist === undefined || title === undefined) return null;
  const safe = sanitize(`${artist} - ${title}`);
  if (safe === "" || safe === "-") return null;
  const truncated = safe.length > MAX_NAME_LEN ? safe.slice(0, MAX_NAME_LEN).trim() : safe;
  return `${truncated}${ext}`;
}

function yearFrom(releaseDate: string | undefined): string | undefined {
  if (releaseDate === undefined) return undefined;
  const m = /^(\d{4})/.exec(releaseDate);
  return m === null ? undefined : m[1];
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

interface ProcessOutcome {
  status: "matched" | "renamed" | "no-match" | "skipped" | "error";
  detail?: string;
}

async function processFile(
  audd: AudD,
  filePath: string,
  apply: boolean,
): Promise<ProcessOutcome> {
  let result: RecognitionResult | null;
  try {
    result = await audd.recognize(filePath);
  } catch (err) {
    return { status: "error", detail: err instanceof Error ? err.message : String(err) };
  }
  if (result === null) return { status: "no-match" };

  const ext = path.extname(filePath).toLowerCase();
  const newName = targetName(result, ext);
  if (newName === null) {
    return { status: "skipped", detail: "missing artist/title" };
  }

  const dir = path.dirname(filePath);
  const newPath = path.join(dir, newName);
  const matchLabel = `${result.artist ?? "?"} - ${result.title ?? "?"}`;

  if (!apply) {
    return { status: "matched", detail: `would rename to "${newName}" -> ${matchLabel}` };
  }

  // Tag writing (MP3 only for now).
  if (RETAGGABLE_EXTS.has(ext)) {
    const tags: NodeID3.Tags = {
      artist: result.artist ?? "",
      title: result.title ?? "",
    };
    if (result.album !== undefined) tags.album = result.album;
    const year = yearFrom(result.releaseDate);
    if (year !== undefined) tags.year = year;
    const ok = NodeID3.update(tags, filePath);
    if (ok !== true) {
      return { status: "error", detail: "node-id3 failed to write tags" };
    }
  }

  if (newPath !== filePath) {
    if (await pathExists(newPath)) {
      return { status: "skipped", detail: `target exists: ${newName}` };
    }
    await rename(filePath, newPath);
  }
  return { status: "renamed", detail: `${newName} -> ${matchLabel}` };
}

async function main(): Promise<void> {
  let args: Args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    console.error(
      "usage: index.ts <folder> [--apply] [--concurrency N]\n" +
        "  default is dry-run; pass --apply to actually rename files.",
    );
    process.exit(2);
  }

  const rootStat = await stat(args.root).catch(() => null);
  if (rootStat === null || !rootStat.isDirectory()) {
    console.error(`not a directory: ${args.root}`);
    process.exit(2);
  }

  const files: string[] = [];
  for await (const f of walk(args.root)) files.push(f);
  if (files.length === 0) {
    console.error(`no audio files found in ${args.root}`);
    return;
  }

  const audd = new AudD();
  const limit = pLimit(args.concurrency);
  const total = files.length;
  let done = 0;
  const counts = { matched: 0, renamed: 0, "no-match": 0, skipped: 0, error: 0 };

  console.log(
    `${args.apply ? "applying" : "DRY RUN"}: ${String(total)} file(s), concurrency=${String(args.concurrency)}`,
  );
  if (!args.apply) console.log("(no files will be modified -- pass --apply to commit)");

  await Promise.all(
    files.map((file) =>
      limit(async () => {
        const outcome = await processFile(audd, file, args.apply);
        done++;
        counts[outcome.status]++;
        const rel = path.relative(args.root, file);
        const line = outcome.detail !== undefined ? `: ${outcome.detail}` : "";
        console.log(
          `[${String(done)}/${String(total)}] ${rel}  ${outcome.status}${line}`,
        );
      }),
    ),
  );

  console.log(
    `done: matched=${String(counts.matched)} renamed=${String(counts.renamed)} ` +
      `no-match=${String(counts["no-match"])} skipped=${String(counts.skipped)} ` +
      `errors=${String(counts.error)}`,
  );
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
