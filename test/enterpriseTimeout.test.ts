/**
 * Node's built-in fetch (undici) gives up after 300 s without response
 * headers, whatever the request's AbortSignal allows. Requests whose SDK
 * timeout is longer (enterprise: 1 hour) go through a dispatcher that turns
 * undici's own headers/body timeouts off, so only the SDK's timeout applies.
 */
import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AudD } from "../src/client.js";
import { AudDConnectionError } from "../src/errors.js";

const GLOBAL_DISPATCHER = Symbol.for("undici.globalDispatcher.1");
const registry = globalThis as unknown as Record<symbol, unknown>;

interface Dispatcher {
  dispatch(options: Record<string, unknown>, handler: unknown): boolean;
}

function asDispatcher(v: unknown): Dispatcher | undefined {
  return typeof v === "object" && v !== null && typeof (v as Dispatcher).dispatch === "function"
    ? (v as Dispatcher)
    : undefined;
}

function enterpriseOk(): Response {
  return new Response(JSON.stringify({ status: "success", result: [] }));
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("requests longer than undici's 300 s limit", () => {
  it("enterprise calls on the built-in fetch carry a dispatcher; standard calls don't", async () => {
    const inits: (RequestInit & { dispatcher?: unknown })[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        inits.push(init ?? {});
        return enterpriseOk();
      }),
    );
    const audd = new AudD({ apiToken: "t" });
    await audd.recognizeEnterprise("https://example.com/long.mp3", { limit: 1 });
    await audd.recognize("https://example.com/clip.mp3").catch(() => undefined);
    await audd.recognize("https://example.com/clip.mp3", { timeoutMs: 400_000 }).catch(() => undefined);
    expect(asDispatcher(inits[0]?.dispatcher)).toBeDefined();
    expect(inits[1]?.dispatcher).toBeUndefined();
    expect(asDispatcher(inits[2]?.dispatcher)).toBeDefined();
  });

  it("the dispatcher hands the request to the global dispatcher with undici's timeouts off", async () => {
    const inits: (RequestInit & { dispatcher?: unknown })[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        inits.push(init ?? {});
        return enterpriseOk();
      }),
    );
    await new AudD({ apiToken: "t" }).recognizeEnterprise("https://example.com/a.mp3", {
      limit: 1,
    });
    const dispatcher = asDispatcher(inits[0]?.dispatcher);
    expect(dispatcher).toBeDefined();

    const original = registry[GLOBAL_DISPATCHER];
    const installed = { dispatch: vi.fn(() => true) };
    registry[GLOBAL_DISPATCHER] = installed;
    try {
      const handler = {};
      dispatcher?.dispatch({ path: "/", headersTimeout: 1, bodyTimeout: 1 }, handler);
      expect(installed.dispatch).toHaveBeenCalledWith(
        { path: "/", headersTimeout: 0, bodyTimeout: 0 },
        handler,
      );
    } finally {
      registry[GLOBAL_DISPATCHER] = original;
    }
  });

  it("a custom fetch gets no dispatcher", async () => {
    const inits: (RequestInit & { dispatcher?: unknown })[] = [];
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      inits.push(init ?? {});
      return enterpriseOk();
    }) as unknown as typeof globalThis.fetch;
    await new AudD({ apiToken: "t", fetch: fetchImpl }).recognizeEnterprise(
      "https://example.com/a.mp3",
      { limit: 1 },
    );
    expect(inits[0]?.dispatcher).toBeUndefined();
  });

  it("an enterprise call outlives undici's headers timeout and uploads once", async () => {
    // Load Node's fetch internals, which install the global dispatcher.
    new Headers();
    const original = asDispatcher(registry[GLOBAL_DISPATCHER]);
    if (original === undefined || original.constructor.name !== "Agent") return;

    // The same limit at a smaller scale: a global dispatcher that waits
    // 300 ms for headers (undici checks its timers about once a second), and
    // a server that answers after 2.5 s.
    const AgentCtor = original.constructor as new (opts: object) => Dispatcher & {
      close(): Promise<void>;
    };
    const short = new AgentCtor({ headersTimeout: 300, bodyTimeout: 300 });
    let uploads = 0;
    const server = http.createServer((req, res) => {
      req.resume();
      req.on("end", () => {
        uploads++;
        setTimeout(() => {
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify({ status: "success", result: [] }));
        }, 2_500);
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    const realFetch = globalThis.fetch;
    vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) => {
      const u = new URL(input instanceof Request ? input.url : String(input));
      return realFetch(`http://127.0.0.1:${String(port)}${u.pathname}`, init);
    });
    registry[GLOBAL_DISPATCHER] = short;
    try {
      const audd = new AudD({ apiToken: "t", maxRetries: 1 });
      await expect(
        audd.recognizeEnterprise(new Uint8Array(10_000), { limit: 1 }),
      ).resolves.toEqual([]);
      expect(uploads).toBe(1);

      // A standard call (60 s timeout) keeps undici's own limit.
      const err = await audd.recognize(new Uint8Array(10_000)).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(AudDConnectionError);
      expect((err as Error).message).toContain("UND_ERR_HEADERS_TIMEOUT");
    } finally {
      registry[GLOBAL_DISPATCHER] = original;
      await short.close();
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  });
});
