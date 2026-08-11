import path from "path";
import { defineConfig } from "vitest/config";

// Mirrors server/vitest.config.ts so worker tests resolve the same @trock-crm/shared aliases and the
// .js→.ts relative imports the worker uses. CI runs `vitest run runtime.test` (see package.json
// test:runtime), so only *.runtime.test.ts execute in the gate; other worker *.test.ts stay local-only.
export default defineConfig({
  resolve: {
    alias: [
      { find: "@trock-crm/shared/schema", replacement: path.resolve(__dirname, "../shared/src/schema/index.ts") },
      { find: "@trock-crm/shared/types", replacement: path.resolve(__dirname, "../shared/src/types/index.ts") },
      { find: "@trock-crm/shared/utils", replacement: path.resolve(__dirname, "../shared/src/utils/normalize.ts") },
      // ONE regex for every shared lib module, instead of a hand-maintained line per file.
      //
      // The per-file list was a standing trap: the `@trock-crm/shared` catch-all below resolves to the SCHEMA
      // barrel, so an UNLISTED lib subpath does not degrade gracefully — it fails to resolve and takes down
      // every suite that transitively imports it. Adding one import to directoryDedup.ts broke 19 unrelated
      // test files (csrf, admin, companies, email, dedup) for exactly that reason, and it was invisible under
      // the DEFAULT vitest config, which resolves via the package's real exports map. A wildcard cannot be
      // forgotten. It MUST stay above the catch-all: alias order is first-match-wins.
      { find: /^@trock-crm\/shared\/lib\/(.*?)(\.js)?$/, replacement: path.resolve(__dirname, "../shared/src/lib/$1.ts") },
      { find: "@trock-crm/shared", replacement: path.resolve(__dirname, "../shared/src/schema/index.ts") },
    ],
  },
  test: {
    globals: false,
    environment: "node",
    include: ["tests/**/*.test.ts"],
    maxWorkers: 4,
    minWorkers: 1,
    testTimeout: 15_000,
  },
});
