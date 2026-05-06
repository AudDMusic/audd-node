/**
 * Recognize a song from a URL.
 *
 * Run: npx tsx examples/recognize-url.ts
 */
import { AudD } from "../src/index.js";

async function main(): Promise<void> {
  const audd = new AudD({ apiToken: "test" });
  const result = await audd.recognize("https://audd.tech/example.mp3");
  if (result) {
    console.log(`${result.artist} — ${result.title}`);
  } else {
    console.log("no match");
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
