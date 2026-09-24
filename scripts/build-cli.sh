#!/usr/bin/env bash
# Bundle the muse CLI into a single self-contained file (wasm inlined).
set -euo pipefail

cd "$(dirname "$0")/.."

[ -f web/public/muse_core.wasm ] || bash scripts/build-wasm.sh

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
