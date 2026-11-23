import { defineConfig } from "vitest/config";

// Only the pure, platform-independent modules (timeline reducer, diff helpers)
// are unit-tested here; they never import react-native.
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    environment: "node",
  },
});
