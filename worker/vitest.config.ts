import path from "path";
import { defineConfig } from "vitest/config";

// Mirrors server/vitest.config.ts so worker tests resolve the same @trock-crm/shared aliases and the
// .js→.ts relative imports the worker uses. CI runs `vitest run runtime.test` (see package.json
// test:runtime), so only *.runtime.test.ts execute in the gate; other worker *.test.ts stay local-only.
export default defineConfig({
  resolve: {
    alias: {
      "@trock-crm/shared/schema": path.resolve(__dirname, "../shared/src/schema/index.ts"),
      "@trock-crm/shared/types": path.resolve(__dirname, "../shared/src/types/index.ts"),
      "@trock-crm/shared/utils": path.resolve(__dirname, "../shared/src/utils/normalize.ts"),
      // lib/* aliases must come before the broad @trock-crm/shared alias to avoid the prefix being
      // replaced with schema/index.ts (which would produce a non-existent path). Mirrors the server
      // vitest.config.ts pattern; add one entry per lib file that worker tests import.
      "@trock-crm/shared/lib/rfpReviewerEmails": path.resolve(__dirname, "../shared/src/lib/rfpReviewerEmails.ts"),
      "@trock-crm/shared/lib/rfpVoterEmails": path.resolve(__dirname, "../shared/src/lib/rfpVoterEmails.ts"),
      "@trock-crm/shared": path.resolve(__dirname, "../shared/src/schema/index.ts"),
    },
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
