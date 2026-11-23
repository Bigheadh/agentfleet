import { defineConfig } from "vitest/config";

// apps/mobile has its own vitest config (run it from that package).
export default defineConfig({
  test: {
    include: ["packages/*/test/**/*.test.ts", "tests/**/*.test.ts"],
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
