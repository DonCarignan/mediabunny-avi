# mediabunny-avi

An AVI **container extension** for [Mediabunny](https://github.com/Vanilagy/mediabunny).

**⚠️ Experimental, unofficial, and not part of Mediabunny.** This is an independent container extension *proposal*, built and maintained outside the Mediabunny project by someone who is **not** a member of its development team. It is not developed, reviewed, endorsed or supported by the Mediabunny maintainers, and it may change or disappear based on what they decide about the underlying API. Treat it as an unpublished `0.1.0` draft: it is on no registry, it makes no stability promise, and its own API can change without notice. Please do not report problems with this package to the Mediabunny issue tracker.

**⚠️ It targets the unreleased `v2` branch, not a published Mediabunny.** The current release on npm is `1.x`; v2 has not shipped. This package depends on two features that are still open pull requests against that branch, [#503](https://github.com/Vanilagy/mediabunny/pull/503) (custom container formats) and [#504](https://github.com/Vanilagy/mediabunny/pull/504) (custom codec names). Either could be reshaped or rejected, in which case this package changes to match, or stops making sense. Until v2 ships there is no registry release to install against, so the `peerDependencies` range (`>=2.0.0-0 <3`) is a placeholder and everything builds and tests against the vendored Mediabunny in `vendor/`. See [CONTRIBUTING.md](./CONTRIBUTING.md) for what that tarball is.

Mediabunny has no built-in support for AVI. This extension adds an AVI input format:

- Legacy `idx1` indexes and OpenDML hierarchical `indx` super-indexes
- OpenDML multi-segment files, so AVI past the 2 GB ceiling
- Files whose index is missing or unusable, by scanning the `movi` lists instead
- RIFF `LIST INFO` metadata tags
- A video track that cannot be described honestly is dropped rather than failing the file, so its audio and tags still read

It cannot write AVI and ships no decoders, so whether a track plays is up to the decoders available rather than to this package — [LIMITATIONS.md](./LIMITATIONS.md) has the codecs it identifies, the up-front scan cost, and what a malformed file costs you.

## Installation

This library peer-depends on Mediabunny. Once both are published, install them together:
```bash
npm install mediabunny mediabunny-avi
```

You can use ESM imports or CommonJS `require`. Load Mediabunny and the extension with the same module system so they share the same classes.

## Usage

```ts
import { BlobSource, Input } from 'mediabunny';
import { AVI } from 'mediabunny-avi';

const input = new Input({ source: new BlobSource(file), formats: [AVI] });
const tracks = await input.getTracks();
```
That's it — Mediabunny now reads AVI files like any other format. `AVI` is an input format singleton like `MP4` or `MATROSKA`, but `ALL_FORMATS` doesn't include it, so pass it in the `formats` list of every `Input` that should read AVI. To read AVI on top of every built-in format, use `formats: [...ALL_FORMATS, AVI]`.

PCM, MP3, ProRes and AVC use Mediabunny's existing codec names; MPEG-4 Part 2 reports `mpeg4`. Anything else reports `null` and keeps its container identifier, with packets carrying raw chunks that can be empty.

For all the ways of using Mediabunny, refer to its [guide](https://mediabunny.dev/guide/introduction).

## Demo

**[Try it in your browser](https://doncarignan.github.io/mediabunny-avi/)** — press **Play sample AVI** to load the file, then the play button to start it. Nothing is uploaded; the file is read in the page. It is Mediabunny's own media player example with AVI added to the format list. See [demo/README.md](./demo/README.md) to run or rebuild it.

## Development

`npm install`, then `npm run check`, `npm run lint`, `npm run build`, `npm test`. [CONTRIBUTING.md](./CONTRIBUTING.md) has the detail, including what `vendor/` contains.

## License

[MPL-2.0](./LICENSE). Copyright (c) 2026-present, Don Carignan and contributors.

The AVI test corpus includes `test/fixtures/opendml.avi` from [OxideAV/oxideav-avi](https://github.com/OxideAV/oxideav-avi), MIT-licensed; see `test/fixtures/LICENSE.OxideAV` and `test/fixtures/README.md`.
