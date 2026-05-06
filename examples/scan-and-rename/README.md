# scan-and-rename

Walk a folder of audio files, recognize each one with AudD, write the
recognized artist/title (and album/year when present) into the file's tags,
then rename it to `Artist - Title.ext`.

## Run

```bash
cd examples/scan-and-rename
npm install
export AUDD_API_TOKEN=...   # from https://dashboard.audd.io

# dry run -- prints what would change, touches nothing
npx tsx index.ts /path/to/library

# commit changes
npx tsx index.ts /path/to/library --apply --concurrency 8
```

Recognition uses up one credit per file.

## What it does

- Walks the folder recursively, picking up `.mp3 .flac .ogg .opus .m4a .mp4 .wav .aac`.
- Calls `audd.recognize(path)` for each file (Node accepts file paths directly).
- On a match: in `--apply` mode writes ID3 tags, then renames to `Artist - Title.ext` after sanitizing filesystem-unsafe characters and capping length at 200.
- Skips on collision (target name already exists), missing artist/title, or `recognize` returning `null`.

Filenames containing `/ \ : * ? " < > |` get those characters replaced with `_`.

## Tag-writing scope

Tag writing currently uses [`node-id3`](https://www.npmjs.com/package/node-id3),
which handles MP3 only. Other formats are still recognized and renamed; their
tags are left untouched. To extend coverage, swap the `NodeID3.update(...)`
call for `node-taglib-sharp` or per-format libraries (`metaflac` for FLAC,
`@taglib/taglib-wasm`, etc.).

## --apply is destructive

`--apply` rewrites tags and renames files in place. There is no undo. Run the
default dry-run first and read the output before committing.

## License note

This example imports [`node-id3`](https://github.com/Zazama/node-id3), which is
distributed under the LGPL. Make sure you're comfortable with that before
shipping anything derived from this code.
