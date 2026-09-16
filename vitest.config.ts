import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
	resolve: {
		alias: {
			// The tests run against the BUILT package, not the sources
			'mediabunny-avi': path.resolve(__dirname, './dist/index.mjs'),
		},
	},
	test: {
		name: 'node',
		root: 'test',
		include: ['**/*.test.ts'],
		environment: 'node',
	},
});
