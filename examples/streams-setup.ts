/**
 * Set up a stream for real-time recognition: register a callback URL,
 * then add a stream.
 *
 * Run: AUDD_API_TOKEN=... npx tsx examples/streams-setup.ts
 */
import { AudD } from "../src/index.js";

async function main(): Promise<void> {
  const audd = new AudD({ apiToken: process.env["AUDD_API_TOKEN"] ?? "test" });

  // Step 1: register your webhook URL.
  await audd.streams.setCallbackUrl("https://your.host/audd-callback", {
    returnMetadata: ["apple_music", "spotify"],
  });

  // Step 2: add a stream. URL accepts direct DASH/Icecast/HLS/m3u(8) URLs
  // and shortcut forms: twitch:<channel>, youtube:<id>, youtube-ch:<channel-id>.
  await audd.streams.add({
    url: "https://npr-ice.streamguys1.com/live.mp3",
    radioId: 999_001,
  });

  // Step 3: list to verify.
  for (const s of await audd.streams.list()) {
    console.log(`${String(s.radioId)}  running=${String(s.streamRunning)}  ${s.url}`);
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
