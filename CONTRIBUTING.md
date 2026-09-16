# Development

```bash
npm install     # resolves Mediabunny from vendor/mediabunny-1.50.7.tgz
npm run check   # tsc --noEmit over src/, test/ and demo/
npm run lint
npm run build   # dist/index.mjs, dist/index.cjs, dist/index.d.ts, dist/index.d.cts
npm test        # runs against the built dist via a vitest alias
```

`npm install` and `npm ci` both work from a clean clone with no extra flags.

## What `vendor/` is

`vendor/mediabunny-1.50.7.tgz` is an `npm pack` of the unreleased Mediabunny build this package targets. It is committed so `npm ci` works without a registry release.

**The `1.50.7` in its filename is an artifact of packing that branch, not a Mediabunny release.** Its contents are a `v2`-branch snapshot carrying [#503](https://github.com/Vanilagy/mediabunny/pull/503) and [#504](https://github.com/Vanilagy/mediabunny/pull/504); they are not the published 1.50.7 and should not be mistaken for it.

Regenerate it with `npm pack --pack-destination <this repo>/vendor` from a Mediabunny checkout that carries both PRs, then update the filename in `package.json` and the lockfile.
