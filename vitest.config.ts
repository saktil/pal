import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // Optional-capability probes that need extra closures (Chromium) run only via `pnpm test:feasibility`.
    exclude: [...configDefaults.exclude, "test/feasibility/**"],
    environment: "node",
    testTimeout: 30_000,
  },
});
