import { defineConfig } from "vitest/config";

// Browser tests against the built UI; they need `pnpm build` and PLAYWRIGHT_BROWSERS_PATH (see nix/e2e.nix).
export default defineConfig({
  test: {
    include: ["test/e2e/**/*.test.ts"],
    environment: "node",
    testTimeout: 60_000,
  },
});
