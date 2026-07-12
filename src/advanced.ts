/**
 * Advanced namespace — lyrics search + raw escape hatch.
 *
 * Reach this only via `audd.advanced.*` — deliberately not on the main
 * client surface.
 */
import {
  AudDSerializationError,
  raiseFromErrorResponse,
} from "./errors.js";
import { emitAround, type OnEventHook } from "./events.js";
import type { FormFieldValue, HttpClient } from "./http.js";
import { parseLyricsResult, type LyricsResult } from "./models.js";
import { runRetried, type RetryPolicy } from "./retry.js";

const API_BASE = "https://api.audd.io";

export class Advanced {
  /**
   * @param recognitionPolicy The findLyrics endpoint is metered and shouldn't
   * double-bill on post-upload read timeout: Advanced uses RECOGNITION retry
   * policy, not READ.
   */
  constructor(
    private readonly http: HttpClient,
    private readonly recognitionPolicy: RetryPolicy,
    private readonly onEvent?: OnEventHook,
  ) {}

  /** Find lyrics by free-text query. Returns a list of matches (possibly empty). */
  async findLyrics(query: string): Promise<LyricsResult[]> {
    const body = await this.rawRequest("findLyrics", { q: query });
    if (body["status"] === "error") {
      raiseFromErrorResponse(body as Parameters<typeof raiseFromErrorResponse>[0], {
        httpStatus: 200,
        requestId: null,
      });
    }
    const result = body["result"];
    if (!Array.isArray(result)) return [];
    return result.map(parseLyricsResult);
  }

  /**
   * Hit any AudD endpoint by method name and return the raw JSON object.
   * Useful for endpoints not yet wrapped by typed methods on this SDK.
   */
  async rawRequest(
    method: string,
    params: Record<string, string | number | boolean | undefined> = {},
  ): Promise<Record<string, unknown>> {
    const fields: Record<string, FormFieldValue> = {};
    for (const [k, v] of Object.entries(params)) {
      if (v === undefined) continue;
      fields[k] = String(v);
    }

    const url = `${API_BASE}/${method}/`;
    const resp = await emitAround(this.onEvent, method, url, () =>
      runRetried(() => this.http.postForm(url, fields), this.recognitionPolicy),
    );
    const body = resp.jsonBody;
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      throw new AudDSerializationError("Unparseable response", resp.rawText);
    }
    return body as Record<string, unknown>;
  }
}
