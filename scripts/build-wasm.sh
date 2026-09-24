#!/usr/bin/env bash
# Build muse-core → wasm32 and stage it for the web app.
set -euo pipefail

cd "$(dirname "$0")/.."

if ! rustup target list --installed | grep -q wasm32-unknown-unknown; then
  rustup target add wasm32-unknown-unknown
fi

cargo build --release --target wasm32-unknown-unknown -p muse-core

mkdir -p web/public
cp target/wasm32-unknown-unknown/release/muse_core.wasm web/public/muse_core.wasm
echo "→ web/public/muse_core.wasm ($(wc -c < web/public/muse_core.wasm) bytes)"
