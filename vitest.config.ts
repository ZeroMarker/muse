import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["web/test/**/*.test.ts"],
    environment: "node",
  },
});
