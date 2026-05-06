import { createHash } from "node:crypto";
import { AudDInvalidRequestError } from "./errors.js";

/**
 * Raised by `addReturnToUrl` (and therefore by `streams.setCallbackUrl`)
 * when the URL already contains a `return` query parameter and a
 * `returnMetadata` argument is also passed — conflicting intent.
 */
export class DuplicateReturnParameterError extends AudDInvalidRequestError {
  override name = "DuplicateReturnParameterError";
  constructor() {
    super({
      errorCode: 0,
      message:
        "URL already contains a `return` query parameter; pass returnMetadata: undefined " +
        "or remove the parameter from the URL — refusing to silently overwrite.",
      httpStatus: 0,
      requestId: null,
      requestedParams: {},
      requestMethod: null,
      brandedMessage: null,
      rawResponse: null,
    });
  }
}

/**
 * Compute the 9-char longpoll category locally from the API token + radio_id.
 *
 * Formula (per docs.audd.io/streams.md): hex-MD5 of (hex-MD5 of api_token,
 * concatenated with the radio_id rendered as a decimal string), truncated
 * to the first 9 hex chars.
 *
 * Pure function — no network call. Lets servers share a longpoll category
 * with browser/mobile clients without leaking the api_token.
 */
export function deriveLongpollCategory(apiToken: string, radioId: number): string {
  const inner = createHash("md5").update(apiToken, "utf8").digest("hex");
  const full = createHash("md5").update(inner + String(radioId), "utf8").digest("hex");
  return full.slice(0, 9);
}

/**
 * Append `?return=<metadata>` (or merge as `&return=`) to the callback URL.
 *
 * - If `returnMetadata` is `undefined`, returns the URL unchanged.
 * - If the URL already has a `return` query parameter, raises rather than
 *   silently overwriting.
 */
export function addReturnToUrl(
  url: string,
  returnMetadata: string | string[] | undefined,
): string {
  if (returnMetadata === undefined) return url;
  const value = Array.isArray(returnMetadata) ? returnMetadata.join(",") : returnMetadata;
  const u = new URL(url);
  if (u.searchParams.has("return")) {
    throw new DuplicateReturnParameterError();
  }
  u.searchParams.set("return", value);
  return u.toString();
}

export { parseStreamCallback as parseCallback } from "./models.js";
