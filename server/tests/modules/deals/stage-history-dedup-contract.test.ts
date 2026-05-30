import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// The forward stage-history backstop (migration 0143) fires on every deals INSERT/UPDATE.
// Any path that ALSO writes deal_stage_history explicitly must suppress the backstop for its
// transaction (app.skip_stage_history_trigger), or the transition is recorded twice. This
// locks that contract for every current explicit-insert path so a future edit cannot drop a
// flag and silently start double-recording. A NEW explicit-insert path must be added here.
const EXPLICIT_INSERT_PATHS = [
  "deals/stage-change.ts",
  "bid-board-sync/service.ts",
  "internal-rfp/routes.ts",
  "procore/synchub-routes.ts",
];

describe("deal_stage_history de-dup contract (every explicit-insert path suppresses the backstop)", () => {
  for (const rel of EXPLICIT_INSERT_PATHS) {
    it(`${rel} writes deal_stage_history AND sets app.skip_stage_history_trigger`, () => {
      const src = readFileSync(new URL(`../../../src/modules/${rel}`, import.meta.url), "utf8");
      // sanity: this path really does insert stage history
      expect(src.toLowerCase()).toMatch(/deal_stage_history|insert\(dealstagehistory\)/);
      // contract: it suppresses the backstop trigger so it does not double-record
      expect(src).toContain("app.skip_stage_history_trigger");
    });
  }
});
