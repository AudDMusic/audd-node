# audd

[![CI](https://github.com/AudDMusic/audd-node/actions/workflows/ci.yml/badge.svg)](https://github.com/AudDMusic/audd-node/actions/workflows/ci.yml)
[![Contract](https://github.com/AudDMusic/audd-node/actions/workflows/contract.yml/badge.svg)](https://github.com/AudDMusic/audd-node/actions/workflows/contract.yml)
[![npm](https://img.shields.io/npm/v/audd.svg)](https://www.npmjs.com/package/audd)

Official TypeScript / Node.js SDK for the [AudD](https://audd.io) music recognition API.

## Quickstart

```bash
npm install audd
```

```ts
import { AudD } from "audd";

const audd = new AudD({ apiToken: "test" }); // grab a real token at https://dashboard.audd.io
const result = await audd.recognize("https://audd.tech/example.mp3");
if (result) {
  console.log(`${result.artist} — ${result.title}`);
}
```

## Capabilities

| What | How |
|---|---|
| Recognize a short clip (≤25s) | `audd.recognize(source)` |
| Recognize a long file (hours, days) | `audd.recognizeEnterprise(source, { limit: ... })` |
| Manage real-time stream recognition | `audd.streams.add({ url, radioId })` etc. |

`source` accepts a URL string, a `URL` object, a file path (Node only),
a `Blob` / `File`, or a `Uint8Array` / `Buffer` — auto-detected.

The full TypeScript types ship in the package — no `@types/audd` needed.

## Errors

Every server error becomes a typed exception:

```ts
import { AudD, AudDAuthenticationError, AudDSubscriptionError } from "audd";

try {
  await new AudD({ apiToken: "bad" }).recognize("https://x.mp3");
} catch (e) {
  if (e instanceof AudDAuthenticationError) {
    console.log(`check your token: ${e.errorCode} ${e.serverMessage}`);
  } else if (e instanceof AudDSubscriptionError) {
    console.log("this endpoint isn't enabled on your token");
  } else {
    throw e;
  }
}
```

The full hierarchy is in [`src/errors.ts`](src/errors.ts). Every
`AudDAPIError` carries `errorCode`, `serverMessage`, `httpStatus`,
`requestId`, `requestedParams`, `requestMethod`, `brandedMessage`, and
`rawResponse`.

## Forward compatibility

Models accept and round-trip unknown server fields via `extras`:

```ts
const result = await audd.recognize("https://example.mp3", { return: ["apple_music"] });
console.log(result?.appleMusic?.url); // typed
console.log(result?.extras);          // any unknown server fields
console.log(result?.rawResponse);     // full unparsed JSON object
```

If AudD adds a new metadata block tomorrow (e.g., `tidal`), you can read
it as `result.extras.tidal` *today* — no SDK release needed. The next SDK
release adds the typed `tidal` field, and both paths keep working.

## Configuration

```ts
import { AudD } from "audd";

const audd = new AudD({
  apiToken: "...",
  maxRetries: 3,        // retry budget per call
  backoffFactorMs: 500, // initial backoff (ms), jittered, exponential
  fetch: customFetch,   // bring your own fetch (proxy, mTLS, observability)
});
```

A single `AudD` instance is safe to share across concurrent requests;
`setApiToken(...)` rotates the token without aborting in-flight calls.

Default timeouts: 60s for standard endpoints, **1 hour** for the
enterprise endpoint. Pass `timeoutMs` per call to override.

## Streams

Manage real-time stream recognition and consume events:

```ts
await audd.streams.add({ url: "https://stream.example/live.m3u8", radioId: "my-radio" });

for await (const event of audd.streams.longpoll("my-radio")) {
  console.log(event);
}
```

### Tokenless longpoll (browser / widget)

For browser or widget builds where you can't ship the api_token, the
`LongpollConsumer` is exported from a separate sub-entry so bundlers
tree-shake the auth client out:

```ts
import { LongpollConsumer } from "audd/longpoll";

// `category` is derived server-side via
// audd.streams.deriveLongpollCategory(radioId), then shipped to the
// browser. The consumer carries no api_token.
const consumer = new LongpollConsumer("abc123def");
for await (const event of consumer.iterate({ timeout: 30 })) {
  console.log(event);
}
```

## Custom catalog (advanced — not for music recognition)

> ⚠ **The custom-catalog endpoint is NOT how you submit audio for music
> recognition.** For recognition, use `recognize()` or
> `recognizeEnterprise()`. The custom-catalog endpoint adds songs to your
> private fingerprint database for *your* account. Requires special
> access — contact api@audd.io if you need it.

```ts
await audd.customCatalog.add({
  audioId: 42,
  source: "https://my.song.mp3",
});
```

## Advanced

A generic raw-request escape hatch lets you call newly-shipped server
methods before the SDK has a typed wrapper:

```ts
const raw = await audd.advanced.rawRequest("someNewMethod", { q: "x" });
```

## Resource cleanup

Both `AudD` and `LongpollConsumer` support
[`Symbol.asyncDispose`](https://github.com/tc39/proposal-explicit-resource-management)
where the runtime supports it. For older runtimes, call `close()`
manually:

```ts
{
  await using audd = new AudD({ apiToken: "..." });
  await audd.recognize("...");
} // close() called automatically here
```

## Spec contract

This SDK builds against the
[`audd-openapi`](https://github.com/AudDMusic/audd-openapi) spec. The
contract tests in `test/contract.test.ts` validate the parsers against
the canonical fixture set on every push, on a daily cron, and on every
spec update.

## License

MIT — see [LICENSE](./LICENSE).

## Support

- Documentation: https://docs.audd.io
- Tokens: https://dashboard.audd.io
- Email: api@audd.io
