/**
 * Opt-in integration tests against the live AudD API.
 *
 * Run: AUDD_API_TOKEN=your_token npm run test:integration
 *
 * Excluded from default `npm test` to avoid hitting the real API on every
 * unit-test run.
 */
import { describe, expect, it } from "vitest";
import { AudD } from "../src/index.js";

const TOKEN = process.env["AUDD_API_TOKEN"] ?? "test";
const SAMPLE_URL = "https://audd.tech/example.mp3";

describe.skipIf(!process.env["AUDD_API_TOKEN"] && TOKEN === "test")(
  "integration (live API)",
  () => {
    it("recognize the canonical sample URL", async () => {
      const audd = new AudD({ apiToken: TOKEN });
      const r = await audd.recognize(SAMPLE_URL);
      expect(r).not.toBeNull();
      expect(r?.artist?.length).toBeGreaterThan(0);
      expect(r?.title?.length).toBeGreaterThan(0);
    }, 60_000);
  },
);

// A second describe that runs with the public test token even without
// AUDD_API_TOKEN set, so CI has at least one live integration call when
// the token isn't configured. The public 'test' token is rate-limited but
// the canonical sample URL is the documented happy path.
describe("integration (public test token)", () => {
  it("recognize the canonical sample URL with the test token", async () => {
    const audd = new AudD({ apiToken: "test" });
    const r = await audd.recognize(SAMPLE_URL);
    expect(r).not.toBeNull();
    expect(r?.artist?.length).toBeGreaterThan(0);
    expect(r?.title?.length).toBeGreaterThan(0);
  }, 60_000);
});
