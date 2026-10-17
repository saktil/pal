import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // Tests that need Chromium run only via `pnpm test:feasibility` and `pnpm test:e2e`.
    exclude: [...configDefaults.exclude, "test/feasibility/**", "test/e2e/**"],
    environment: "node",
    testTimeout: 30_000,
  },
});
