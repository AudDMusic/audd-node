/**
 * Recognize a long file via the enterprise endpoint.
 *
 * Run: AUDD_API_TOKEN=... npx tsx examples/recognize-enterprise.ts
 */
import { AudD } from "../src/index.js";

async function main(): Promise<void> {
  const audd = new AudD({ apiToken: process.env["AUDD_API_TOKEN"] ?? "test" });
  const matches = await audd.recognizeEnterprise("https://audd.tech/example.mp3", {
    limit: 1, // always pass limit when developing
  });
  for (const m of matches) {
    console.log(`${m.timecode}  ${m.artist} — ${m.title}  (score=${String(m.score)})`);
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
