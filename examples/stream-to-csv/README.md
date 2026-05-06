# stream-to-csv

Subscribe to a live audio stream and append every recognition to a CSV file.

## Run

```bash
cd examples/stream-to-csv
npm install
export AUDD_API_TOKEN=...   # from https://dashboard.audd.io

npx tsx index.ts "https://npr-ice.streamguys1.com/live.mp3" \
  --radio-id 99999 \
  --output recordings.csv
```

Press Ctrl+C to stop. The script deletes the stream on the way out.

## CSV columns

`timestamp, radio_id, score, artist, title, album, song_link`

Each row is flushed as it arrives. Stream notifications (start/stop, errors)
are printed to stderr and not written to the CSV.

## Callback URL handling

Longpoll silently no-ops on accounts with no callback URL set, so the script
calls `streams.getCallbackUrl()` first. If your account has a callback URL
configured (probably your real production receiver), the script leaves it
alone. Otherwise it registers `https://audd.tech/empty/` as a placeholder
that satisfies the API but discards events.

On Ctrl+C the script removes the stream. If we registered the placeholder
callback, we leave it in place: the AudD API doesn't expose a way to clear
a callback URL, only to overwrite it. If you need it gone, set your real
receiver via `audd.streams.setCallbackUrl(...)` afterwards.

## Streams require a paid plan

The free `test` token does not have stream access. You'll need a token from
[dashboard.audd.io](https://dashboard.audd.io) on a plan that includes streams.
