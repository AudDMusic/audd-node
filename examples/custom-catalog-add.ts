/**
 * Add a song to your private fingerprint catalog.
 *
 * **NOT for music recognition** — this adds songs *you* host to a private
 * catalog so AudD's recognition can later identify *your* tracks for
 * *your account only*. Requires special access — contact api@audd.io.
 *
 * For recognition, use `audd.recognize(...)` instead.
 *
 * Run: AUDD_API_TOKEN=... npx tsx examples/custom-catalog-add.ts
 */
import { AudD } from "../src/index.js";

async function main(): Promise<void> {
  const audd = new AudD({ apiToken: process.env["AUDD_API_TOKEN"] ?? "test" });
  await audd.customCatalog.add({
    audioId: 42,
    source: "https://my.example.com/track.mp3",
  });
  console.log("ok");
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
