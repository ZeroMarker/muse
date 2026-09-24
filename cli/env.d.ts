// Ambient types for CLI-only imports.

declare module "*.wasm" {
  // esbuild (`--loader:.wasm=binary`) inlines bytes; vite/vitest gives a URL.
  const src: string | Uint8Array;
  export default src;
}
