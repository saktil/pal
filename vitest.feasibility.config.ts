import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/feasibility/**/*.test.ts"],
    environment: "node",
    testTimeout: 60_000,
  },
});
