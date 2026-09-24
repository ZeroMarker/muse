import { defineConfig } from "vite";

export default defineConfig({
  root: "web",
  base: "./",
  build: {
    outDir: "../dist",
    emptyOutDir: true,
    target: "es2022",
    sourcemap: true,
    // emit the audio worklet as a real file (data: URLs are flaky in addModule)
    assetsInlineLimit: 0,
  },
  server: {
    port: 5173,
    host: true,
  },
  worker: {
    format: "es",
  },
});
