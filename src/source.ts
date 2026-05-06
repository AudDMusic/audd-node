/**
 * Auto-detect what kind of audio source the caller passed and convert to
 * the right multipart fields.
 *
 * Returns a *re-opener* — a 0-arg callable that yields fresh form fields
 * on each call. The HTTP layer invokes it inside the retry-wrapped request
 * closure, so retried attempts get fresh body content rather than an
 * exhausted stream / spent buffer.
 *
 * Specifically: `fetch()` does NOT auto-rewind a `Blob` constructed over a
 * stream once the body is consumed; the re-opener pattern is mandatory in
 * Node/browsers (the audd-python C1 review note discusses this — Python's
 * httpx auto-seeks; ours doesn't always).
 */

import { promises as fsPromises, statSync } from "node:fs";
import * as path from "node:path";
import type { FormFieldValue } from "./http.js";

/**
 * Audio source the caller passes to `recognize` / `recognizeEnterprise` /
 * `customCatalog.add`. Auto-detected:
 *
 * - `string` starting with `http://` or `https://` → URL parameter
 * - `string` other → resolved as a filesystem path on Node (TypeError in browsers)
 * - `URL` → URL parameter
 * - `Blob` / `File` → multipart upload
 * - `Uint8Array` / `Buffer` → multipart upload
 */
export type Source = string | URL | Blob | Uint8Array;

export interface PreparedRequest {
  fields: Record<string, FormFieldValue>;
  /** True for multipart uploads (file body sent), false when only URL passed. */
  isMultipart: boolean;
}

export type SourceReopener = () => Promise<PreparedRequest>;

function looksLikeUrl(s: string): boolean {
  return s.startsWith("http://") || s.startsWith("https://");
}

function isNodeRuntime(): boolean {
  return (
    typeof process !== "undefined" &&
    process.versions !== undefined &&
    typeof process.versions.node === "string"
  );
}

/**
 * Inspect a source and return a re-opener.
 *
 * URLs go via `data.url`; bytes/blobs/paths go via `data.file` (multipart).
 * Each call to the returned re-opener yields a fresh body so retry doesn't
 * see an empty/exhausted buffer.
 */
export function prepareSource(source: Source): SourceReopener {
  if (typeof source === "string") {
    if (looksLikeUrl(source)) {
      const url = source;
      return () => Promise.resolve({ fields: { url }, isMultipart: false });
    }
    if (!isNodeRuntime()) {
      throw new TypeError(
        `Source string ${JSON.stringify(source)} is not an HTTP URL (must start with ` +
          `http:// or https://). Filesystem paths are only supported on Node. In a ` +
          `browser, pass a Blob/File or Uint8Array instead.`,
      );
    }
    // Filesystem path. Verify existence eagerly so a typo'd URL doesn't get
    // treated as a path that fails much later with a less-actionable error.
    let exists = false;
    try {
      exists = statSync(source).isFile();
    } catch {
      exists = false;
    }
    if (!exists) {
      throw new TypeError(
        `${JSON.stringify(source)} is not an HTTP URL (must start with http:// or ` +
          `https://) and is not an existing file path. Pass a URL, a path, a Blob, or ` +
          `bytes.`,
      );
    }
    const filePath = source;
    const filename = path.basename(filePath);
    return async () => {
      const buf = await fsPromises.readFile(filePath);
      const blob = new Blob([new Uint8Array(buf)], {
        type: "application/octet-stream",
      });
      const file = new File([blob], filename, { type: "application/octet-stream" });
      return { fields: { file }, isMultipart: true };
    };
  }

  if (source instanceof URL) {
    const url = source.toString();
    return () => Promise.resolve({ fields: { url }, isMultipart: false });
  }

  if (typeof Blob !== "undefined" && source instanceof Blob) {
    // Blob is fundamentally re-readable — fetch will re-stream it.
    const blob = source;
    const filename = "name" in blob && typeof blob.name === "string" ? blob.name : "upload.bin";
    return () => {
      const file = new File([blob], filename, { type: blob.type || "application/octet-stream" });
      return Promise.resolve({ fields: { file }, isMultipart: true });
    };
  }

  if (source instanceof Uint8Array) {
    // Snapshot the bytes once (defensive copy) and produce a fresh Blob each
    // attempt so concurrent retries can't trample each other's bodies.
    const buf = new Uint8Array(source);
    return () => {
      const blob = new Blob([buf], { type: "application/octet-stream" });
      const file = new File([blob], "upload.bin", { type: "application/octet-stream" });
      return Promise.resolve({ fields: { file }, isMultipart: true });
    };
  }

  throw new TypeError(
    `Unsupported source type ${typeof source}; pass a URL string, URL, Blob/File, ` +
      `Uint8Array, or Buffer.`,
  );
}
