import { defineConfig, mergeConfig } from "vitest/config";
import config from "./vitest.config.ts";

export default mergeConfig(
  config,
  defineConfig({
    test: {
      exclude: [
        // These suites require immutable Nix programs or Linux release-lock/source-confinement primitives.
        "test/mcp-local.test.ts",
        "test/mcp-stdio.test.ts",
        "test/release-policy.test.ts",
        "test/release-state.test.ts",
      ],
    },
  }),
);
