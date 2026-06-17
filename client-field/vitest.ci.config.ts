import { mergeConfig, defineConfig, configDefaults } from "vitest/config";
import viteConfig from "./vite.config";

// Pre-merge CI gate config for client-field (T-Rock Cam field app): runs the UNIT tests
// (src/**/*.{test,spec}.{ts,tsx}), excluding the Playwright e2e specs under e2e/ (their own browser
// job). This workspace had a `test` script but NO `test:ci`, so `npm run test:ci --workspaces
// --if-present` skipped it entirely and its 15 unit suites never ran in CI (#747). jsdom is per-file
// via the `// @vitest-environment jsdom` directive, matching the client workspace.
//
// QUARANTINE (#746): none — all client-field unit suites pass. Same rules as the other workspaces:
// quarantine + burn down, never `.skip`.
const QUARANTINE: string[] = [];

export default mergeConfig(
  viteConfig,
  defineConfig({
    test: {
      include: ["src/**/*.{test,spec}.{ts,tsx}"],
      exclude: [...configDefaults.exclude, "e2e/**", ...QUARANTINE],
    },
  }),
);
