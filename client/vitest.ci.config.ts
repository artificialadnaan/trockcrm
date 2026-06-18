import { mergeConfig, defineConfig, configDefaults } from "vitest/config";
import viteConfig from "./vite.config";

// Pre-merge CI gate config: runs the client UNIT tests (src/**/*.{test,spec}.{ts,tsx}), minus a
// shrinking QUARANTINE. The `include` deliberately scopes to src/ so the Playwright e2e specs under
// client/e2e/ are NOT run here — those have their own `test:e2e` (browser) job.
//
// QUARANTINE (#743/#746) — fully drained: every client suite is now fixed and runs in the gate.
// Keep this array (empty) so re-quarantining a future regression is a one-line, documented change,
// never a `.skip`.
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
