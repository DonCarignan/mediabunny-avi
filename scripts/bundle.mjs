import * as esbuild from 'esbuild';

/** ESM and CommonJS entries for bundlers and Node. `mediabunny` stays external. */
const baseConfig = {
	entryPoints: ['src/index.ts'],
	bundle: true,
	logLevel: 'info',
	target: 'es2021',
	external: ['mediabunny'],
	banner: {
		js: `/*!
 * Copyright (c) 2026-present, Don Carignan and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */`,
	},
	legalComments: 'none',
};

await esbuild.build({
	...baseConfig,
	format: 'esm',
	outfile: 'dist/index.mjs',
});

await esbuild.build({
	...baseConfig,
	format: 'cjs',
	platform: 'node',
	outfile: 'dist/index.cjs',
});
