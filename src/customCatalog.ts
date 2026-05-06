/**
 * Custom-catalog endpoint. NOT for music recognition — see method JSDoc.
 */
import {
  AudDConnectionError,
  AudDSerializationError,
  AudDServerError,
  raiseFromErrorResponse,
} from "./errors.js";
import type { FormFieldValue, HttpClient, HttpResponse } from "./http.js";
import { retry, type RetryPolicy } from "./retry.js";
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

async function runRetried<T extends HttpResponse>(
  fn: () => Promise<T>,
  policy: RetryPolicy,
): Promise<T> {
  try {
    return await retry(fn, policy);
  } catch (err) {
    if (err instanceof TypeError) {
      throw new AudDConnectionError(`Network error: ${err.message}`, err);
    }
    if (err !== null && typeof err === "object" && (err as { name?: string }).name === "AbortError") {
      throw new AudDConnectionError("Request was aborted (timeout)", err);
    }
    throw err;
  }
}

export class CustomCatalog {
  constructor(
    private readonly http: HttpClient,
    private readonly mutatingPolicy: RetryPolicy,
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
   */
  async add(opts: CustomCatalogAddOptions): Promise<void> {
    const reopen = prepareSource(opts.source);
    const audioId = String(opts.audioId);

    const resp = await runRetried(async () => {
      const prepared = await reopen();
      const fields: Record<string, FormFieldValue> = { ...prepared.fields, audio_id: audioId };
      return this.http.postForm(UPLOAD_URL, fields);
    }, this.mutatingPolicy);

    decodeSuccess(resp.jsonBody, resp.httpStatus, resp.requestId);
  }
}
