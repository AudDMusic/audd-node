/**
 * Custom-catalog endpoint. NOT for music recognition — see method JSDoc.
 */
import {
  AudDSerializationError,
  AudDServerError,
  raiseFromErrorResponse,
} from "./errors.js";
import { emitAround, type OnEventHook } from "./events.js";
import type { FormFieldValue, HttpClient } from "./http.js";
import { runRetried, type RetryPolicy } from "./retry.js";
import { prepareSource, type Source } from "./source.js";

const UPLOAD_URL = "https://api.audd.io/upload/";

export interface CustomCatalogAddOptions {
  audioId: number;
  source: Source;
}

function decodeSuccess(body: unknown, httpStatus: number, requestId: string | null): void {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new AudDSerializationError("Unparseable response");
  }
  const obj = body as Record<string, unknown> & { status?: unknown };
  if (obj.status === "error") {
    raiseFromErrorResponse(obj as Parameters<typeof raiseFromErrorResponse>[0], {
      httpStatus,
      requestId,
      customCatalogContext: true,
    });
  }
  if (obj.status !== "success") {
    throw new AudDServerError({
      errorCode: 0,
      message: `Unexpected status: ${JSON.stringify(obj.status)}`,
      httpStatus,
      requestId,
      rawResponse: obj,
    });
  }
}

export class CustomCatalog {
  constructor(
    private readonly http: HttpClient,
    private readonly noRetryPolicy: RetryPolicy,
    private readonly onEvent?: OnEventHook,
  ) {}

  /**
   * **This is NOT how you submit audio for music recognition.** For
   * recognition, use `audd.recognize()` (or `audd.recognizeEnterprise()` for
   * files longer than 25 seconds). This method adds a song to your
   * **private fingerprint catalog** so AudD's recognition can later identify
   * *your own* tracks for *your account only*. Requires special access —
   * contact api@audd.io if you need it enabled.
   *
   * Calling this again with the same `audioId` re-fingerprints that slot.
   * There is no public list/delete endpoint; track `audioId` ↔ song
   * mappings on your side.
   *
   * **No automatic retry.** Custom-catalog upload is metered, and a transport
   * failure could otherwise cause a silent re-upload that double-charges. Any
   * 5xx or pre-upload connection error surfaces as a clean exception — the
   * caller decides whether to retry.
   */
  async add(opts: CustomCatalogAddOptions): Promise<void> {
    const reopen = prepareSource(opts.source);
    const audioId = String(opts.audioId);

    const resp = await emitAround(this.onEvent, "customCatalogAdd", UPLOAD_URL, () =>
      runRetried(async () => {
        const prepared = await reopen();
        const fields: Record<string, FormFieldValue> = { ...prepared.fields, audio_id: audioId };
        return this.http.postForm(UPLOAD_URL, fields);
      }, this.noRetryPolicy),
    );

    decodeSuccess(resp.jsonBody, resp.httpStatus, resp.requestId);
  }
}
