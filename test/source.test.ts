import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { prepareSource } from "../src/source.js";

describe("prepareSource", () => {
  it("URL string sets data.url, no multipart", async () => {
    const reopener = prepareSource("https://audd.tech/example.mp3");
    const r1 = await reopener();
    expect(r1.fields["url"]).toBe("https://audd.tech/example.mp3");
    expect(r1.isMultipart).toBe(false);
    expect(r1.fields["file"]).toBeUndefined();
  });

  it("URL object sets data.url", async () => {
    const reopener = prepareSource(new URL("https://audd.tech/example.mp3"));
    const r1 = await reopener();
    expect(r1.fields["url"]).toBe("https://audd.tech/example.mp3");
  });

  it("re-opener can be called multiple times (URL)", async () => {
    const reopener = prepareSource("https://audd.tech/example.mp3");
    const r1 = await reopener();
    const r2 = await reopener();
    expect(r1.fields["url"]).toBe(r2.fields["url"]);
  });

  it("Uint8Array source produces a multipart File", async () => {
    const bytes = new Uint8Array([1, 2, 3, 4, 5]);
    const reopener = prepareSource(bytes);
    const r1 = await reopener();
    expect(r1.isMultipart).toBe(true);
    expect(r1.fields["file"]).toBeInstanceOf(Blob);
  });

  it("Uint8Array re-opener yields fresh File on each call", async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const reopener = prepareSource(bytes);
    const r1 = await reopener();
    const r2 = await reopener();
    expect(r1.fields["file"]).not.toBe(r2.fields["file"]);
  });

  it("Buffer (Node) accepted as Uint8Array", async () => {
    const buf = Buffer.from([0xff, 0xee]);
    const reopener = prepareSource(buf);
    const r = await reopener();
    expect(r.isMultipart).toBe(true);
    expect(r.fields["file"]).toBeInstanceOf(Blob);
  });

  it("Blob accepted directly", async () => {
    const blob = new Blob([new Uint8Array([1, 2, 3])], { type: "audio/mpeg" });
    const reopener = prepareSource(blob);
    const r = await reopener();
    expect(r.isMultipart).toBe(true);
    expect(r.fields["file"]).toBeInstanceOf(Blob);
  });

  it("filesystem path on Node opens fresh handle each attempt", async () => {
    const dir = mkdtempSync(join(tmpdir(), "audd-source-"));
    const filePath = join(dir, "hello.bin");
    writeFileSync(filePath, "hello world");
    const reopener = prepareSource(filePath);
    const r1 = await reopener();
    const r2 = await reopener();
    expect(r1.isMultipart).toBe(true);
    expect(r1.fields["file"]).toBeInstanceOf(Blob);
    expect(r2.fields["file"]).toBeInstanceOf(Blob);
  });

  it("typo'd URL (no scheme) and non-existent path raises TypeError with hint", () => {
    expect(() => prepareSource("audd.tech/example.mp3")).toThrowError(/HTTP URL/);
  });

  it("unsupported type raises TypeError", () => {
    // @ts-expect-error — invalid runtime input
    expect(() => prepareSource(42)).toThrow(TypeError);
  });
});
