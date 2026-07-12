import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { userAgent } from "../src/userAgent.js";
import { VERSION } from "../src/version.js";

describe("VERSION", () => {
  it("matches package.json — the User-Agent must not misreport the release", () => {
    const pkg = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    ) as { version: string };
    expect(VERSION).toBe(pkg.version);
  });

  it("is what the User-Agent reports", () => {
    expect(userAgent()).toContain(`audd-node/${VERSION}`);
  });
});
