import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: [
      // esbuild inlines .wasm as bytes; vite can't import it raw → stub it,
      // cli/core.ts falls back to reading web/public/muse_core.wasm from disk.
      {
        find: /.*[\\/]web[\\/]public[\\/]muse_core\.wasm$/,
        replacement: resolve(__dirname, "web/test/wasm-stub.ts"),
      },
    ],
  },
  test: {
    include: ["web/test/**/*.test.ts"],
    environment: "node",
  },
});
