/** Exception hierarchy for AudD API errors. */

export interface AudDApiErrorFields {
  errorCode: number;
  message: string;
  httpStatus: number;
  requestId: string | null;
  requestedParams: Record<string, unknown>;
  requestMethod: string | null;
  brandedMessage: string | null;
  rawResponse: unknown;
}

export type AudDApiErrorInit = Partial<AudDApiErrorFields> &
  Pick<AudDApiErrorFields, "errorCode" | "message" | "httpStatus">;

/** Base for everything thrown by this SDK. */
export class AudDError extends Error {
  override name = "AudDError";
}

/** Server returned `status: error`. Carries the AudD error code + the full echo. */
export class AudDAPIError extends AudDError {
  override name = "AudDAPIError";
  errorCode: number;
  httpStatus: number;
  requestId: string | null;
  requestedParams: Record<string, unknown>;
  requestMethod: string | null;
  brandedMessage: string | null;
  rawResponse: unknown;
  /** Original `error_message` from the server. (`Error.message` may be overridden by subclasses.) */
  serverMessage: string;

  constructor(init: AudDApiErrorInit) {
    super(`[#${init.errorCode}] ${init.message}`);
    this.errorCode = init.errorCode;
    this.serverMessage = init.message;
    this.httpStatus = init.httpStatus;
    this.requestId = init.requestId ?? null;
    this.requestedParams = init.requestedParams ?? {};
    this.requestMethod = init.requestMethod ?? null;
    this.brandedMessage = init.brandedMessage ?? null;
    this.rawResponse = init.rawResponse ?? null;
  }
}

export class AudDAuthenticationError extends AudDAPIError {
  override name = "AudDAuthenticationError";
}
export class AudDQuotaError extends AudDAPIError {
  override name = "AudDQuotaError";
}
export class AudDSubscriptionError extends AudDAPIError {
  override name = "AudDSubscriptionError";
}
export class AudDCustomCatalogAccessError extends AudDSubscriptionError {
  override name = "AudDCustomCatalogAccessError";
}
export class AudDInvalidRequestError extends AudDAPIError {
  override name = "AudDInvalidRequestError";
}
export class AudDInvalidAudioError extends AudDAPIError {
  override name = "AudDInvalidAudioError";
}
export class AudDRateLimitError extends AudDAPIError {
  override name = "AudDRateLimitError";
}
export class AudDStreamLimitError extends AudDAPIError {
  override name = "AudDStreamLimitError";
}
export class AudDNotReleasedError extends AudDAPIError {
  override name = "AudDNotReleasedError";
}
export class AudDBlockedError extends AudDAPIError {
  override name = "AudDBlockedError";
}
export class AudDNeedsUpdateError extends AudDAPIError {
  override name = "AudDNeedsUpdateError";
}
export class AudDServerError extends AudDAPIError {
  override name = "AudDServerError";
}

export class AudDConnectionError extends AudDError {
  override name = "AudDConnectionError";
  override cause?: unknown;
  constructor(message: string, cause?: unknown) {
    super(message);
    this.cause = cause;
  }
}

export class AudDSerializationError extends AudDError {
  override name = "AudDSerializationError";
  rawText: string;
  constructor(message: string, rawText = "") {
    super(message);
    this.rawText = rawText;
  }
}

export type AudDAPIErrorCtor = new (init: AudDApiErrorInit) => AudDAPIError;

const CODE_MAP: Record<number, AudDAPIErrorCtor> = {
  900: AudDAuthenticationError,
  901: AudDAuthenticationError,
  903: AudDAuthenticationError,
  902: AudDQuotaError,
  904: AudDSubscriptionError,
  905: AudDSubscriptionError,
  50: AudDInvalidRequestError,
  51: AudDInvalidRequestError,
  600: AudDInvalidRequestError,
  601: AudDInvalidRequestError,
  602: AudDInvalidRequestError,
  700: AudDInvalidRequestError,
  701: AudDInvalidRequestError,
  702: AudDInvalidRequestError,
  906: AudDInvalidRequestError,
  300: AudDInvalidAudioError,
  400: AudDInvalidAudioError,
  500: AudDInvalidAudioError,
  610: AudDStreamLimitError,
  611: AudDRateLimitError,
  907: AudDNotReleasedError,
  19: AudDBlockedError,
  31337: AudDBlockedError,
  20: AudDNeedsUpdateError,
  100: AudDServerError,
  1000: AudDServerError,
};

export function errorClassForCode(code: number): AudDAPIErrorCtor {
  return CODE_MAP[code] ?? AudDServerError;
}

function brandedMessageOf(result: unknown): string | null {
  if (typeof result !== "object" || result === null) return null;
  const r = result as { artist?: unknown; title?: unknown };
  const parts: string[] = [];
  if (typeof r.artist === "string" && r.artist.length > 0) parts.push(r.artist);
  if (typeof r.title === "string" && r.title.length > 0) parts.push(r.title);
  return parts.length === 0 ? null : parts.join(" — ");
}

export interface ServerErrorBody {
  error?: { error_code?: number | undefined; error_message?: string | undefined } | undefined;
  result?: unknown;
  request_params?: Record<string, unknown> | undefined;
  requested_params?: Record<string, unknown> | undefined;
  request_api_method?: string | undefined;
}

export interface RaiseFromErrorOpts {
  httpStatus: number;
  requestId: string | null;
  customCatalogContext?: boolean;
}

const CUSTOM_CATALOG_PREFIX =
  "Adding songs to your custom catalog requires enterprise access that isn't enabled on your account.\n\n" +
  "Note: the custom-catalog endpoint is for adding songs to your private fingerprint database, not for music recognition. " +
  "If you intended to identify music, use recognize(...) (or recognizeEnterprise(...) for files longer than 25 seconds) instead.\n\n" +
  "To request custom-catalog access, contact api@audd.io.\n\n";

export function raiseFromErrorResponse(body: ServerErrorBody, opts: RaiseFromErrorOpts): never {
  const code = body.error?.error_code ?? 0;
  const message = body.error?.error_message ?? "";
  const requestedParams = body.request_params ?? body.requested_params ?? {};
  const requestMethod = body.request_api_method ?? null;
  const branded = brandedMessageOf(body.result);

  const fields: AudDApiErrorFields = {
    errorCode: code,
    message,
    httpStatus: opts.httpStatus,
    requestId: opts.requestId,
    requestedParams,
    requestMethod,
    brandedMessage: branded,
    rawResponse: body,
  };

  const Cls = errorClassForCode(code);
  if (opts.customCatalogContext === true && Cls === AudDSubscriptionError) {
    const overridden = `${CUSTOM_CATALOG_PREFIX}[Server message: ${message}]`;
    throw new AudDCustomCatalogAccessError({ ...fields, message: overridden });
  }
  throw new Cls(fields);
}
