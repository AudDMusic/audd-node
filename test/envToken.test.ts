import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { AudD } from "../src/client.js";

const ORIG_TOKEN = process.env["AUDD_API_TOKEN"];

afterEach(() => {
  if (ORIG_TOKEN === undefined) delete process.env["AUDD_API_TOKEN"];
  else process.env["AUDD_API_TOKEN"] = ORIG_TOKEN;
});

describe("env-var pickup (AUDD_API_TOKEN)", () => {
  beforeEach(() => {
    delete process.env["AUDD_API_TOKEN"];
  });

  it("supplies token from env when arg omitted", () => {
    process.env["AUDD_API_TOKEN"] = "from-env";
    const audd = new AudD();
    expect(audd.apiToken).toBe("from-env");
  });

  it("explicit arg wins over env", () => {
    process.env["AUDD_API_TOKEN"] = "from-env";
    const audd = new AudD({ apiToken: "explicit" });
    expect(audd.apiToken).toBe("explicit");
  });

  it("throws when neither is set", () => {
    expect(() => new AudD()).toThrow(/dashboard\.audd\.io/);
  });

  it("throws when token is empty string and env unset", () => {
    expect(() => new AudD({ apiToken: "" })).toThrow();
  });
});
