/** Official TypeScript SDK for the AudD music recognition API. */

export { VERSION } from "./version.js";

export {
  AudD,
  type AudDOptions,
  type RecognizeOptions,
  type RecognizeEnterpriseOptions,
  type ReturnMetadata,
  type AudDEvent,
  type AudDEventKind,
  type OnEventHook,
} from "./client.js";
export type { StreamingProvider } from "./models.js";

export {
  AudDError,
  AudDAPIError,
  AudDAuthenticationError,
  AudDBlockedError,
  AudDConnectionError,
  AudDCustomCatalogAccessError,
  AudDInvalidAudioError,
  AudDInvalidRequestError,
  AudDNeedsUpdateError,
  AudDNotReleasedError,
  AudDQuotaError,
  AudDRateLimitError,
  AudDSerializationError,
  AudDServerError,
  AudDStreamLimitError,
  AudDSubscriptionError,
  errorClassForCode,
} from "./errors.js";

export type {
  RecognitionResult,
  EnterpriseMatch,
  EnterpriseChunkResult,
  Stream as StreamRecord,
  StreamCallbackMatch,
  StreamCallbackSong,
  StreamCallbackNotification,
  LyricsResult,
} from "./models.js";

export type { Source } from "./source.js";
export type { Streams, SetCallbackUrlOptions, AddStreamOptions, LongpollOptions } from "./streams.js";
export type { LongpollPoll } from "./longpollCore.js";
export type { CustomCatalog, CustomCatalogAddOptions } from "./customCatalog.js";
export type { Advanced } from "./advanced.js";

export {
  deriveLongpollCategory,
  addReturnToUrl,
  parseCallback,
  handleCallback,
  DuplicateReturnParameterError,
  type ParsedCallback,
} from "./helpers.js";
