import { defineConfig, mergeConfig } from "vitest/config";
import baseConfig from "./vitest.config";

// Root-level scripts/*.test.ts (one-off backfills / data tooling) live outside every workspace's Vitest
// include, so the per-workspace `test:ci` gate never runs them. This config scopes the root Vitest to just
// those files (reusing the base aliases) so `npm run test:scripts` can run them in the pre-merge gate.
// The single-star `scripts/*.test.ts` matches only the repo-root scripts dir, NOT server/tests/scripts/**.
//
// The root `vitest` binary is v3 (pinned transitively by the root devDep @vitest/coverage-v8@^3.2.4 and
// hoisted to the root node_modules/.bin, same as the existing root vitest.config.ts), independent of the
// client workspace's vitest v4 — so the gate runs these node-env script tests on v3 exactly as locally.
export default mergeConfig(
  baseConfig,
  defineConfig({
    test: {
      include: ["scripts/*.test.ts"],
    },
  })
);
