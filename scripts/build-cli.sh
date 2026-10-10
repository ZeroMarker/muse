#!/usr/bin/env bash
# Bundle the muse CLI into a single self-contained file (wasm inlined).
set -euo pipefail

cd "$(dirname "$0")/.."

# Cargo rebuilds incrementally so the bundle always contains the current core.
bash scripts/build-wasm.sh

mkdir -p dist/cli
npx esbuild cli/index.ts \
  --bundle \
  --platform=node \
  --format=cjs \
  --target=node18 \
  --loader:.wasm=binary \
  --banner:js="#!/usr/bin/env node" \
  --sourcemap \
  --outfile=dist/cli/muse.cjs

chmod +x dist/cli/muse.cjs
echo "→ dist/cli/muse.cjs ($(wc -c < dist/cli/muse.cjs) bytes, wasm inlined)"
