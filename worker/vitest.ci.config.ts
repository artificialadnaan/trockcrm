import { mergeConfig, defineConfig, configDefaults } from "vitest/config";
import base from "./vitest.config";

// Pre-merge CI gate config for the worker, mirroring server/vitest.ci.config.ts.
//
// Until now the root gate skipped this workspace ENTIRELY: it runs
// `npm run test:ci --workspaces --if-present` and `worker` defined no `test:ci`, so `--if-present`
// silently passed over 464 tests. PR #982 shipped a red worker test through a green gate that way.
//
// The base `include` is only `tests/**`, which left 14 colocated `src/**/*.test.ts` suites (~81 tests)
// matched by NOTHING — invisible to CI *and* to `npm test`. Adding them here (rather than to the base)
// keeps `test`/`test:runtime` behaving exactly as before and confines the change to the gate.
//
// QUARANTINE — a documented, one-line lever for a suite that fails in CI but not locally (the worker's
// PGlite runtime suites are the likeliest candidates, being timing- and resource-sensitive on a shared
// runner). Prefer quarantining with a tracking issue over `.skip`, and never leave an entry undocumented.
const QUARANTINE: string[] = [];

export default mergeConfig(
  base,
  defineConfig({
    test: {
      include: ["tests/**/*.test.ts", "src/**/*.test.ts"],
      exclude: [...configDefaults.exclude, ...QUARANTINE],
    },
  }),
);
