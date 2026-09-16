#!/bin/bash
set -e

# This script must be executed via `npm run build`

# Clear the stuff from last build
rm -rf dist

# Type check & generate .d.ts files
tsc -p tsconfig.build.json

# Creates the ESM and CommonJS bundles
node scripts/bundle.mjs

# Copy the declarations for CommonJS consumers
cp dist/index.d.ts dist/index.d.cts
