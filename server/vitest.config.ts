import path from "path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@trock-crm/shared/schema": path.resolve(__dirname, "../shared/src/schema/index.ts"),
      "@trock-crm/shared/types": path.resolve(__dirname, "../shared/src/types/index.ts"),
      "@trock-crm/shared/utils": path.resolve(__dirname, "../shared/src/utils/normalize.ts"),
      "@trock-crm/shared/lib/correctiveActionOrder": path.resolve(__dirname, "../shared/src/lib/correctiveActionOrder.ts"),
      "@trock-crm/shared/lib/bidBoardStatusMap": path.resolve(__dirname, "../shared/src/lib/bidBoardStatusMap.ts"),
      "@trock-crm/shared/lib/correctiveActionApprovers": path.resolve(__dirname, "../shared/src/lib/correctiveActionApprovers.ts"),
      "@trock-crm/shared/lib/rfpReviewerEmails": path.resolve(__dirname, "../shared/src/lib/rfpReviewerEmails.ts"),
      "@trock-crm/shared/lib/rfpVoterEmails": path.resolve(__dirname, "../shared/src/lib/rfpVoterEmails.ts"),
      "@trock-crm/shared/lib/rfpVoteState": path.resolve(__dirname, "../shared/src/lib/rfpVoteState.ts"),
      "@trock-crm/shared/lib/userProvisioningGuards": path.resolve(__dirname, "../shared/src/lib/userProvisioningGuards.ts"),
      "@trock-crm/shared/lib/commission-structure": path.resolve(__dirname, "../shared/src/lib/commission-structure.ts"),
      // Every shared subpath needs its own entry here — the `@trock-crm/shared` catch-all on the next line
      // resolves to the SCHEMA barrel, not to the package's exports map, so an unlisted `lib/*` import does
      // not fall back gracefully: it fails to resolve and takes down every suite that transitively imports
      // it. Omitting this one broke 19 test files (csrf, admin, companies, email, dedup) with a single
      // import added to directoryDedup.ts, while the DEFAULT vitest config resolved it fine via the real
      // exports map — so it was invisible until `server test:ci`, which is what the gate actually runs.
      "@trock-crm/shared/lib/responderNameMatch": path.resolve(__dirname, "../shared/src/lib/responderNameMatch.ts"),
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
    // PGlite-backed *.runtime.test.* suites boot an in-process Postgres and seed fixtures in beforeAll,
    // which can exceed Vitest's 10s default hook timeout under normal startup latency (the seed hook is
    // NOT covered by testTimeout). Give hooks headroom so the default test command never flakes/skips.
    hookTimeout: 30_000,
  },
});
