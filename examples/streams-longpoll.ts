/**
 * Listen for AudD recognition events via longpoll, no callback URL needed.
 *
 * Note: the SDK preflights getCallbackUrl on the first iteration. If your
 * account doesn't have a callback URL configured, set one via:
 *
 *     await audd.streams.setCallbackUrl("https://audd.tech/empty/");
 *
 * (or pass skipCallbackCheck: true to bypass the preflight, if you know
 * what you're doing).
 *
 * Run: AUDD_API_TOKEN=... npx tsx examples/streams-longpoll.ts <radioId>
 */
import { AudD } from "../src/index.js";

async function main(): Promise<void> {
  const radioIdRaw = process.argv[2];
  if (!radioIdRaw) {
    console.error("usage: streams-longpoll.ts <radio-id>");
    process.exit(2);
  }
  const audd = new AudD({ apiToken: process.env["AUDD_API_TOKEN"] ?? "test" });
  const radioId = parseInt(radioIdRaw, 10);
  const category = audd.streams.deriveLongpollCategory(radioId);
  for await (const payload of audd.streams.longpoll(category, { timeout: 30 })) {
    console.log(JSON.stringify(payload));
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
