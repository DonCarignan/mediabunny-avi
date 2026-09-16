import path from 'path';
import { defineConfig } from 'vite';

export default defineConfig({
	root: 'demo',
	// Relative URLs, so the build can be served from any subpath such as GitHub Pages
	base: './',
	resolve: {
		alias: {
			// The demo runs against the BUILT package, like the tests do
			'mediabunny-avi': path.resolve(__dirname, './dist/index.mjs'),
		},
	},
	build: {
		outDir: path.resolve(__dirname, './dist-demo'),
		emptyOutDir: true,
	},
});
