// Vitest alias target for `*.wasm` imports: bundling inlines the bytes, but
// under vite the import must resolve to something harmless — the CLI loads
// the real file from disk via `fromFs()` in that environment.
const stub = "";
export default stub;
