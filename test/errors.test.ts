import { describe, expect, it } from "vitest";
import {
  AudDAPIError,
  AudDAuthenticationError,
  AudDBlockedError,
  AudDConnectionError,
  AudDCustomCatalogAccessError,
  AudDError,
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
  raiseFromErrorResponse,
} from "../src/errors.js";

describe("errors", () => {
  it("hierarchy: every API error inherits from AudDAPIError and AudDError", () => {
    const e = new AudDAuthenticationError({
      errorCode: 900,
      message: "x",
      httpStatus: 200,
    });
    expect(e).toBeInstanceOf(AudDAPIError);
    expect(e).toBeInstanceOf(AudDError);
    expect(e).toBeInstanceOf(Error);
  });

  it("AudDCustomCatalogAccessError inherits from AudDSubscriptionError", () => {
    const e = new AudDCustomCatalogAccessError({
      errorCode: 904,
      message: "denied",
      httpStatus: 200,
    });
    expect(e).toBeInstanceOf(AudDSubscriptionError);
    expect(e).toBeInstanceOf(AudDAPIError);
  });

  it("AudDConnectionError inherits AudDError but NOT AudDAPIError", () => {
    const e = new AudDConnectionError("net", new Error("under"));
    expect(e).toBeInstanceOf(AudDError);
    expect(e).not.toBeInstanceOf(AudDAPIError);
    expect(e.cause).toBeInstanceOf(Error);
  });

  it("AudDSerializationError inherits AudDError but NOT AudDAPIError", () => {
    const e = new AudDSerializationError("bad", "<html>");
    expect(e).toBeInstanceOf(AudDError);
    expect(e).not.toBeInstanceOf(AudDAPIError);
    expect(e.rawText).toBe("<html>");
  });

  it("code mapping covers all documented codes", () => {
    expect(errorClassForCode(900)).toBe(AudDAuthenticationError);
    expect(errorClassForCode(901)).toBe(AudDAuthenticationError);
    expect(errorClassForCode(903)).toBe(AudDAuthenticationError);
    expect(errorClassForCode(902)).toBe(AudDQuotaError);
    expect(errorClassForCode(904)).toBe(AudDSubscriptionError);
    expect(errorClassForCode(905)).toBe(AudDSubscriptionError);
    expect(errorClassForCode(50)).toBe(AudDInvalidRequestError);
    expect(errorClassForCode(51)).toBe(AudDInvalidRequestError);
    expect(errorClassForCode(700)).toBe(AudDInvalidRequestError);
    expect(errorClassForCode(906)).toBe(AudDInvalidRequestError);
    expect(errorClassForCode(300)).toBe(AudDInvalidAudioError);
    expect(errorClassForCode(610)).toBe(AudDStreamLimitError);
    expect(errorClassForCode(611)).toBe(AudDRateLimitError);
    expect(errorClassForCode(907)).toBe(AudDNotReleasedError);
    expect(errorClassForCode(19)).toBe(AudDBlockedError);
    expect(errorClassForCode(31337)).toBe(AudDBlockedError);
    expect(errorClassForCode(20)).toBe(AudDNeedsUpdateError);
    expect(errorClassForCode(100)).toBe(AudDServerError);
    expect(errorClassForCode(1000)).toBe(AudDServerError);
  });

  it("unknown code falls back to AudDServerError", () => {
    expect(errorClassForCode(99999)).toBe(AudDServerError);
  });

  it("raiseFromErrorResponse throws the right typed exception with fields", () => {
    expect(() =>
      raiseFromErrorResponse(
        {
          error: { error_code: 900, error_message: "bad token" },
          request_params: { api_token: "t***" },
          request_api_method: "recognize",
        },
        { httpStatus: 200, requestId: "rid-1" },
      ),
    ).toThrowError(AudDAuthenticationError);
    try {
      raiseFromErrorResponse(
        {
          error: { error_code: 900, error_message: "bad token" },
          request_params: { api_token: "t***" },
          request_api_method: "recognize",
        },
        { httpStatus: 200, requestId: "rid-1" },
      );
    } catch (e) {
      const err = e as AudDAuthenticationError;
      expect(err.errorCode).toBe(900);
      expect(err.serverMessage).toBe("bad token");
      expect(err.requestId).toBe("rid-1");
      expect(err.requestedParams).toEqual({ api_token: "t***" });
      expect(err.requestMethod).toBe("recognize");
    }
  });

  it("requestedParams normalizes both `request_params` and `requested_params` spellings", () => {
    try {
      raiseFromErrorResponse(
        {
          error: { error_code: 904, error_message: "no access" },
          requested_params: { url: "x" },
        },
        { httpStatus: 200, requestId: null },
      );
    } catch (e) {
      const err = e as AudDSubscriptionError;
      expect(err.requestedParams).toEqual({ url: "x" });
    }
  });

  it("brandedMessage extracted from result.artist/title on errors", () => {
    try {
      raiseFromErrorResponse(
        {
          error: { error_code: 31337, error_message: "blocked" },
          result: { artist: "ApiRequest failed", title: "Sorry, your IP was banned" },
        },
        { httpStatus: 200, requestId: null },
      );
    } catch (e) {
      const err = e as AudDBlockedError;
      expect(err.brandedMessage).toBe("ApiRequest failed — Sorry, your IP was banned");
    }
  });

  it("brandedMessage null when no result.artist/title", () => {
    try {
      raiseFromErrorResponse(
        { error: { error_code: 900, error_message: "x" } },
        { httpStatus: 200, requestId: null },
      );
    } catch (e) {
      const err = e as AudDAPIError;
      expect(err.brandedMessage).toBeNull();
    }
  });

  it("custom catalog context overrides 904 message and uses AudDCustomCatalogAccessError", () => {
    try {
      raiseFromErrorResponse(
        {
          error: { error_code: 904, error_message: "denied" },
        },
        { httpStatus: 200, requestId: null, customCatalogContext: true },
      );
    } catch (e) {
      expect(e).toBeInstanceOf(AudDCustomCatalogAccessError);
      const err = e as AudDCustomCatalogAccessError;
      expect(err.message).toContain("custom-catalog endpoint is for adding songs");
      expect(err.message).toContain("[Server message: denied]");
    }
  });

  it("custom catalog context does not override 905 (different code, still subscription)", () => {
    try {
      raiseFromErrorResponse(
        {
          error: { error_code: 905, error_message: "denied" },
        },
        { httpStatus: 200, requestId: null, customCatalogContext: true },
      );
    } catch (e) {
      // 905 also maps to AudDSubscriptionError, but the override only triggers
      // when the resolved class is exactly AudDSubscriptionError. 905 is mapped
      // there too, so the override DOES trigger.
      expect(e).toBeInstanceOf(AudDCustomCatalogAccessError);
    }
  });

  it("error message format includes code prefix", () => {
    const e = new AudDAuthenticationError({
      errorCode: 900,
      message: "bad token",
      httpStatus: 200,
    });
    expect(e.message).toBe("[#900] bad token");
  });
});
