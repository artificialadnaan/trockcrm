import { mergeConfig, defineConfig, configDefaults } from "vitest/config";
import base from "./vitest.config";

// Pre-merge CI gate config: runs ALL unit tests (tests/**/*.test.ts, per the base `include`), minus a
// shrinking QUARANTINE of pre-existing failing suites. This broadens the gate from the old
// runtime-only filter (~97 files) so the ~700 passing suites now run in CI and new breakage is caught.
//
// QUARANTINE (#743/#746) — fully drained: every server suite is now fixed and runs in the gate.
// Keep this array (empty) so re-quarantining a future regression is a one-line, documented change,
// never a `.skip`. Do NOT add entries without a #746 (or successor) checkbox.
const QUARANTINE: string[] = [];

export default mergeConfig(
  base,
  defineConfig({
    test: {
      // Base `include` is only tests/**; the gate must also run the colocated server/src/**/*.test.ts
      // unit suites (r2-client, projects/service, reports, etc.) that were otherwise invisible (#747).
      include: ["tests/**/*.test.ts", "src/**/*.test.ts"],
      exclude: [...configDefaults.exclude, ...QUARANTINE],
    },
  }),
);
