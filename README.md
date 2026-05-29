# audd-node

[![CI](https://github.com/AudDMusic/audd-node/actions/workflows/ci.yml/badge.svg)](https://github.com/AudDMusic/audd-node/actions/workflows/ci.yml)
[![Contract](https://github.com/AudDMusic/audd-node/actions/workflows/contract.yml/badge.svg)](https://github.com/AudDMusic/audd-node/actions/workflows/contract.yml)
[![npm](https://img.shields.io/npm/v/@audd/sdk.svg)](https://www.npmjs.com/package/@audd/sdk)

Official TypeScript / Node.js SDK for [music recognition API](https://audd.io): identify music from a short audio clip, a long audio file, or a live stream.

The API itself is so simple that it can easily be used even without an SDK: [docs.audd.io](https://docs.audd.io).

## Quickstart

```bash
npm install @audd/sdk
```

Get your API token at [dashboard.audd.io](https://dashboard.audd.io).

Recognize from a URL:

```ts
import { AudD } from "@audd/sdk";

const audd = new AudD("your-api-token");
const song = await audd.recognize("https://audd.tech/example.mp3");
if (song) {
  console.log(`${song.artist} — ${song.title}`);
}
```

Recognize a local file (Node):

```ts
import { AudD } from "@audd/sdk";
import { readFile } from "node:fs/promises";

const audd = new AudD("your-api-token");

// Pass a path…
const song = await audd.recognize("./clip.mp3");

// …or pass bytes directly.
const bytes = await readFile("./clip.mp3");
const song2 = await audd.recognize(bytes);
```

A `null` return means the server completed the request successfully but
found no match — distinct from an error, which throws.

## Authentication

Pass the token literally:

```ts
const audd = new AudD("d29ebb...");
```

Or set `AUDD_API_TOKEN` in the environment and construct without
arguments:

```ts
const audd = new AudD();
```

For long-running services that rotate credentials, swap the token at
runtime without aborting in-flight requests:

```ts
audd.setApiToken(nextToken);
```

## What you get back

By default, `recognize` resolves to a typed `RecognitionResult` with core
tags plus AudD's universal song link — no metadata-block opt-in needed:

```ts
const song = await audd.recognize("https://audd.tech/example.mp3");
if (!song) return;

// Core fields
console.log(song.artist, song.title, song.album);
console.log(song.releaseDate, song.label, song.timecode);

// AudD's universal song page — links into every provider
console.log(song.songLink);

// Helpers — driven off songLink, work without any `returnMetadata` opt-in
console.log(song.thumbnailUrl);             // cover-art image, or null
console.log(song.streamingUrl("spotify"));  // direct or lis.tn redirect
console.log(song.streamingUrls());          // map of provider -> URL
```

If you need provider-specific metadata blocks, opt in per call. Request
only what you need — each provider you ask for adds latency:

```ts
const song = await audd.recognize("https://audd.tech/example.mp3", {
  returnMetadata: ["apple_music", "spotify"],
});
console.log(song?.appleMusic?.url);   // direct Apple Music link
console.log(song?.spotify?.uri);      // spotify:track:...
console.log(song?.previewUrl());      // first preview across requested providers, or null
```

Valid `returnMetadata` values: `apple_music`, `spotify`, `deezer`, `napster`,
`musicbrainz`. Blocks are `undefined` when not requested.

`streamingUrl(provider)` prefers the direct provider URL when you
requested that block via `returnMetadata`, then falls back to the lis.tn redirect
when `songLink` is on `lis.tn`. YouTube has only the redirect path.

## Reading additional metadata

Every model carries an `extras` map with any server-side fields outside
the typed surface, plus a `rawResponse` of the full unparsed JSON. Use
`extras` to read fields outside the typed surface:

```ts
console.log(song.extras);       // any non-typed top-level fields
console.log(song.rawResponse);  // the whole result object as the server returned it
```

For the **request** side, every call accepts an `extraParameters` map for additional form fields the typed options don't cover:

```ts
await audd.recognize(url, {
  returnMetadata: "apple_music",
  extraParameters: { some_beta_flag: "true" },
});
```

The same `extraParameters` field is on `RecognizeEnterpriseOptions`, `SetCallbackUrlOptions`, and `AddStreamOptions`. Typed options win on collision.

## Long files (enterprise)

`recognizeEnterprise` accepts files up to several hours and returns a
flat array of matches:

```ts
const matches = await audd.recognizeEnterprise("./show.mp3", { limit: 20 });

for (const m of matches) {
  console.log(m.timecode, m.artist, m.title);
}
```

`EnterpriseMatch` carries the same core tags plus `score`, `startOffset`,
`endOffset`, `isrc`, `upc`. Access to `isrc`, `upc`, and `score` requires
a Startup plan or higher — [contact us](mailto:api@audd.io) for enterprise
features.

The default per-call timeout is **1 hour** for this endpoint (60s for
standard recognition); override with `timeoutMs`.

## Errors

Every server error is a typed exception. Use `instanceof` to branch:

```ts
import {
  AudD,
  AudDAPIError,
  AudDAuthenticationError,
  AudDQuotaError,
  AudDSubscriptionError,
  AudDInvalidAudioError,
  AudDRateLimitError,
  AudDConnectionError,
} from "@audd/sdk";

try {
  await audd.recognize("./clip.mp3");
} catch (err) {
  if (err instanceof AudDAuthenticationError) {
    // 900 / 901 / 903 — token rejected
  } else if (err instanceof AudDQuotaError) {
    // 902 — out of credits
  } else if (err instanceof AudDSubscriptionError) {
    // 904 / 905 — endpoint not enabled on this token
  } else if (err instanceof AudDInvalidAudioError) {
    // 300 / 400 / 500 — file unreadable / too short / unsupported
  } else if (err instanceof AudDRateLimitError) {
    // 611 — too many requests, slow down
  } else if (err instanceof AudDConnectionError) {
    // network failure or aborted request
  } else if (err instanceof AudDAPIError) {
    console.error(err.errorCode, err.serverMessage, err.requestId);
  } else {
    throw err;
  }
}
```

Every `AudDAPIError` exposes `errorCode`, `serverMessage`, `httpStatus`,
`requestId`, `requestedParams`, `requestMethod`, `brandedMessage`, and
`rawResponse`. The full hierarchy lives in
[`src/errors.ts`](src/errors.ts).

## Configuration

```ts
import { AudD } from "@audd/sdk";

const audd = new AudD("...token...", {
  maxRetries: 3,        // retry budget per call
  backoffFactorMs: 500, // initial backoff (ms), jittered, exponential
  fetch: customFetch,   // bring your own fetch (proxy, mTLS, observability)
  onEvent: (e) => {     // request/response/exception inspection hook
    console.log(e.method, e.httpStatus, e.elapsedMs, e.requestId);
  },
});
```

Per-call cancellation via `AbortSignal`, including for multi-hour
enterprise calls:

```ts
const controller = new AbortController();
setTimeout(() => controller.abort(), 30_000);

const matches = await audd.recognizeEnterprise("./show.mp3", {
  signal: controller.signal,
  limit: 50,
});
```

The constructor also accepts an options-only form
(`new AudD({ apiToken, ... })`) if you'd rather pass everything as one
object — equivalent to the two-argument form above.

A single client instance handles concurrent requests fine; spin up one
per process, not one per call.

## Streams

Real-time recognition over a live audio stream. Once a stream is
registered, AudD POSTs each match to your callback URL — or if you
can't host one, drains events to a longpoll endpoint instead.

```ts
await audd.streams.setCallbackUrl("https://your.app/audd-callback", {
  returnMetadata: ["apple_music", "musicbrainz"],
});

await audd.streams.add({
  url: "https://stream.example/live.m3u8",
  radioId: 12345,
});

const streams = await audd.streams.list();
```

### Handling callback POSTs

Drop `handleCallback` into any HTTP handler — Express, Fastify, Hono,
or the bare `node:http` module. It duck-types the request: a Web
`Request`, a Node `IncomingMessage`, or a framework request whose body
has already been parsed all work without configuration.

```ts
import express from "express";
import { handleCallback } from "@audd/sdk";

const app = express();
app.use(express.json());

app.post("/audd-callback", async (req, res) => {
  const { match, notification } = await handleCallback(req);
  if (match) {
    console.log(`${match.song.artist} - ${match.song.title}  score=${match.song.score}`);
    for (const alt of match.alternatives) {
      // alternatives are variant catalog releases — different artist/title is possible
      console.log(`  alt: ${alt.artist} - ${alt.title}`);
    }
  } else if (notification) {
    console.log(`#${notification.notificationCode} ${notification.notificationMessage}`);
  }
  res.json({ ok: true });
});
```

If you already have the body bytes (queue consumer, replay tool), call
`parseCallback(body)` directly — it accepts a parsed JSON object or a
JSON string and returns the same `{ match, notification }` shape.

#### Per-framework wiring

The same `handleCallback(req)` works across Node web frameworks — register
a POST route and pass the request object in.

`Fastify`:

```ts
import Fastify from "fastify";
import { handleCallback } from "@audd/sdk";

const app = Fastify();
app.post("/audd-callback", async (req, reply) => {
  const { match } = await handleCallback(req);
  if (match) console.log(`${match.song.artist} — ${match.song.title}`);
  return { ok: true };
});
```

`Koa`:

```ts
import Koa from "koa";
import Router from "@koa/router";
import bodyParser from "koa-bodyparser";
import { handleCallback } from "@audd/sdk";

const app = new Koa();
const router = new Router();

app.use(bodyParser());
router.post("/audd-callback", async (ctx) => {
  const { match } = await handleCallback(ctx.request);
  if (match) console.log(`${match.song.artist} — ${match.song.title}`);
  ctx.body = { ok: true };
});
app.use(router.routes());
```

`Next.js` (App Router, `app/api/audd-callback/route.ts`):

```ts
import { NextRequest, NextResponse } from "next/server";
import { handleCallback } from "@audd/sdk";

export async function POST(req: NextRequest) {
  const { match } = await handleCallback(req);
  if (match) console.log(`${match.song.artist} — ${match.song.title}`);
  return NextResponse.json({ ok: true });
}
```

### Receiving events without a callback URL (longpoll)

Useful when you can't expose a public HTTPS receiver. The poll handle
exposes three async-iterables — `matches`, `notifications`, `errors` —
filled by a background loop. Iterate them independently, or in parallel
via `Promise.all`.

Before the first request the SDK runs a one-time `getCallbackUrl`
preflight: AudD silently discards events for accounts without any
callback URL set, and the preflight surfaces that as an actionable
error. Pass `skipCallbackCheck: true` to bypass.

```ts
const radioId = 1; // any integer you choose — your handle for this stream

const poll = await audd.streams.longpoll({ radioId, timeout: 30 });
for await (const m of poll.matches) {
  console.log(m.song.artist, m.song.title);
}
```

Consume matches and notifications concurrently:

```ts
await Promise.all([
  (async () => {
    for await (const m of poll.matches) {
      console.log("match:", m.song.artist, m.song.title);
    }
  })(),
  (async () => {
    for await (const n of poll.notifications) {
      console.log("notification:", n.notificationMessage);
    }
  })(),
  (async () => {
    for await (const err of poll.errors) {
      console.error(err);
      poll.close();
    }
  })(),
]);
```

`poll.close()` (or the `await using` resource-management form) tears
down the background loop and completes all three iterables.

### Browser / widget consumers

The `audd/longpoll` sub-entry exports a tokenless `LongpollConsumer` for
front-end use. It carries no api_token — your server derives the
category and ships it to the browser. Bundlers tree-shake the auth
client out of the resulting bundle.

```ts
import { LongpollConsumer } from "@audd/sdk/longpoll";

const consumer = new LongpollConsumer("abc123def");
const poll = consumer.iterate({ timeout: 30 });
for await (const m of poll.matches) {
  console.log(m.song.artist, m.song.title);
}
```

## Custom catalog (advanced — not for music recognition)

> The custom-catalog endpoint is **not** how you submit audio for
> recognition. For recognition, use `recognize()` or
> `recognizeEnterprise()`. This endpoint adds songs to your private
> fingerprint database. Requires special access — contact api@audd.io.

```ts
await audd.customCatalog.add({
  audioId: 42,
  source: "https://example.com/my-track.mp3",
});
```

A raw-request escape hatch is available under `audd.advanced.rawRequest`
for endpoints not yet wrapped on this SDK.

## Resource cleanup

Both `AudD` and `LongpollConsumer` implement `Symbol.asyncDispose` for
[explicit resource management](https://github.com/tc39/proposal-explicit-resource-management):

```ts
{
  await using audd = new AudD("...");
  await audd.recognize("...");
} // close() called automatically here
```

Older runtimes can call `close()` manually.

## License

MIT — see [LICENSE](./LICENSE).

## Support

- Documentation: https://docs.audd.io
- Tokens: https://dashboard.audd.io
- Email: api@audd.io
