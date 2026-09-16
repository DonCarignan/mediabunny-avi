# Demo

A playable player for the containers these extensions add, live at **[doncarignan.github.io/mediabunny-avi](https://doncarignan.github.io/mediabunny-avi/)**.

```bash
npm run demo         # dev server
npm run demo:build   # static build into dist-demo/, servable from any subpath
```

Both scripts build the package first; the demo runs against `dist/`, as the tests do. The build is self-contained — Mediabunny is bundled in from `vendor/` — so the output is static files with no runtime dependency on a registry release.

## Adding an extension

`media-player.ts` derives everything from one `EXTENSIONS` registry: the format list passed to `Input`, the list shown on the page, the file picker's accepted types, and one sample button per extension that ships a sample. Adding another container package means adding a row.

## What differs from upstream

It is Mediabunny's own [media player example](https://github.com/Vanilagy/mediabunny/tree/main/examples/media-player) (MPL-2.0). The only change to how it reads media is the format list:

```ts
formats: [...ALL_FORMATS, AVI]
```

The rest is presentation — an AVI sample, inline SVG control icons, no Mediabunny site chrome, a panel listing the opened file's container and tracks — with one exception: when a track cannot be played the message names the codec, as in `Unable to decode the video track (mpeg4, FMP4)`. "Unable to decode" on its own leaves you no way to find out what your file actually holds. The playback logic is untouched.

## The sample file

`public/sample.avi` is 10 seconds of AVC video with MP3 audio, generated with FFmpeg 8.0:

```sh
ffmpeg -f lavfi -i testsrc2=size=640x360:rate=25:duration=10 \
	-f lavfi -i sine=frequency=440:sample_rate=44100:duration=10 \
	-c:v libx264 -preset medium -bf 0 -g 25 -crf 23 -pix_fmt yuv420p -c:a libmp3lame -ac 2 -b:a 96k sample.avi
```

AVC is what it uses because browsers can decode it. MPEG-4 Part 2 is the codec most real-world AVI files carry, and no browser decodes it, so such a file loads and reports its tracks but will not play without a custom decoder.
