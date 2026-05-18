/**
 * Recognize a song from a local file path or buffer.
 *
 * Run: npx tsx examples/recognize-file.ts path/to/song.mp3
 */
import { readFile } from "node:fs/promises";
import { AudD } from "../src/index.js";

async function main(): Promise<void> {
  const path = process.argv[2];
  if (!path) {
    console.error("usage: recognize-file.ts <path-to-audio>");
    process.exit(2);
  }
  const audd = new AudD({ apiToken: process.env["AUDD_API_TOKEN"] ?? "test" });

  // Pass a path directly (Node only):
  const r1 = await audd.recognize(path);
  console.log("by path:", r1?.artist, "—", r1?.title);

  // Or pass bytes:
  const buf = await readFile(path);
  const r2 = await audd.recognize(new Uint8Array(buf));
  console.log("by bytes:", r2?.artist, "—", r2?.title);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
