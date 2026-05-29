import { userAgent } from "./userAgent.js";

export interface HttpResponse {
  jsonBody: unknown;
  httpStatus: number;
  requestId: string | null;
  rawText: string;
}

export type FetchLike = typeof globalThis.fetch;

export interface HttpClientOptions {
  apiToken: string;
  fetch?: FetchLike;
  /** Per-call timeout in ms. Defaults: 60_000 standard, 3_600_000 enterprise. */
  defaultTimeoutMs?: number;
}

export const STANDARD_TIMEOUT_MS = 60_000;
export const ENTERPRISE_TIMEOUT_MS = 3_600_000;

/**
 * Form-data field value. Strings go through directly; Blob carries binary
 * payloads with a filename when constructed via `new File()`.
 */
export type FormFieldValue = string | Blob | undefined;

export class HttpClient {
  private apiToken: string;
  private readonly fetchImpl: FetchLike;
  private readonly defaultTimeoutMs: number;

  constructor(opts: HttpClientOptions) {
    this.apiToken = opts.apiToken;
    this.fetchImpl = opts.fetch ?? ((globalThis.fetch as FetchLike).bind(globalThis));
    this.defaultTimeoutMs = opts.defaultTimeoutMs ?? STANDARD_TIMEOUT_MS;
  }

  /** Atomically swap the token used for subsequent requests. */
  setApiToken(newToken: string): void {
    this.apiToken = newToken;
  }

  async postForm(
    url: string,
    fields: Record<string, FormFieldValue>,
    opts: { timeoutMs?: number; signal?: AbortSignal } = {},
  ): Promise<HttpResponse> {
    const form = new FormData();
    form.set("api_token", this.apiToken);
    for (const [k, v] of Object.entries(fields)) {
      if (v === undefined) continue;
      form.set(k, v);
    }
    return this.send(url, { method: "POST", body: form }, opts);
  }

  async get(
    url: string,
    params: Record<string, string | undefined>,
    opts: { timeoutMs?: number; signal?: AbortSignal } = {},
  ): Promise<HttpResponse> {
    const u = new URL(url);
    if (!u.searchParams.has("api_token")) u.searchParams.set("api_token", this.apiToken);
    for (const [k, v] of Object.entries(params)) {
      if (v === undefined) continue;
      u.searchParams.set(k, v);
    }
    return this.send(u.toString(), { method: "GET" }, opts);
  }

  private async send(
    url: string,
    init: RequestInit,
    { timeoutMs, signal: userSignal }: { timeoutMs?: number; signal?: AbortSignal },
  ): Promise<HttpResponse> {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
    }, timeoutMs ?? this.defaultTimeoutMs);
    // If user passed a signal, abort our controller when theirs fires.
    const userAbortHandler = (): void => controller.abort();
    if (userSignal !== undefined) {
      if (userSignal.aborted) {
        controller.abort();
      } else {
        userSignal.addEventListener("abort", userAbortHandler, { once: true });
      }
    }
    try {
      const headers = new Headers(init.headers);
      headers.set("User-Agent", userAgent());
      const response = await this.fetchImpl(url, {
        ...init,
        headers,
        signal: controller.signal,
      });
      const text = await response.text();
      let json: unknown = null;
      if (text !== "") {
        try {
          json = JSON.parse(text);
        } catch {
          json = null;
        }
      }
      return {
        jsonBody: json,
        httpStatus: response.status,
        requestId: response.headers.get("x-request-id"),
        rawText: text,
      };
    } finally {
      clearTimeout(timer);
      if (userSignal !== undefined) {
        userSignal.removeEventListener("abort", userAbortHandler);
      }
    }
  }
}
