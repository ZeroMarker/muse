// Load the muse-core wasm for the CLI — self-contained when bundled
// (esbuild inlines the .wasm as bytes), filesystem fallback under vitest.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import wasmAsset from "../web/public/muse_core.wasm";
import { WasmCore } from "../web/src/wasm";

function fromFs(): Uint8Array | null {
  const candidates = [
    process.env.MUSE_WASM,
    typeof __dirname !== "undefined" ? join(__dirname, "muse_core.wasm") : null,
    join(process.cwd(), "web/public/muse_core.wasm"),
    join(process.cwd(), "muse_core.wasm"),
  ].filter((c): c is string => Boolean(c));
  for (const c of candidates) {
    if (existsSync(c)) return new Uint8Array(readFileSync(c));
  }
  return null;
}

export async function loadCore(): Promise<WasmCore> {
  const asset: unknown = wasmAsset;
  const bytes =
    asset instanceof Uint8Array ? asset : fromFs();
  if (!bytes) {
    throw new Error(
      "muse_core.wasm not found — run `npm run build:wasm` (or set MUSE_WASM)",
    );
  }
  return WasmCore.fromBytes(bytes as unknown as BufferSource);
}
