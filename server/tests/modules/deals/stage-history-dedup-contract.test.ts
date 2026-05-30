import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// The forward stage-history backstop (migration 0143) fires on every deals INSERT/UPDATE.
// Any path that ALSO writes deal_stage_history while changing deals.stage_id must suppress
// the backstop for its transaction (app.skip_stage_history_trigger), or the transition is
// recorded twice. This test scans the WHOLE repo (server + worker) so a new history-writer
// in ANY package cannot slip through unclassified -- the gap that hid the worker path.

const REPO_ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
const SCAN_ROOTS = [
  fileURLToPath(new URL("../../../src", import.meta.url)), // server/src
  fileURLToPath(new URL("../../../../worker/src", import.meta.url)), // worker/src
];
const INSERT_RE = /insert\s+into\s+\S*deal_stage_history|insert\(dealstagehistory\)/i;

// Every file that writes deal_stage_history, each classified as either trigger-firing (it
// also changes deals.stage_id, so it MUST set the skip flag) or exempt (it does not change
// stage, so the backstop never fires for it). A new writer forces a deliberate edit here.
const TRIGGER_FIRING = [
  "server/src/modules/deals/stage-change.ts",
  "server/src/modules/bid-board-sync/service.ts",
  "server/src/modules/internal-rfp/routes.ts",
  "server/src/modules/procore/synchub-routes.ts",
  "worker/src/jobs/procore-sync.ts",
];
const FLAG_EXEMPT = [
  "server/src/modules/auth/service.ts", // demo seed backfill: inserts history, no stage UPDATE
];

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const p = `${dir}/${entry}`;
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (p.endsWith(".ts") && !p.includes(".test.")) out.push(p);
  }
  return out;
}

const found = SCAN_ROOTS.flatMap(walk)
  .filter((file) => INSERT_RE.test(readFileSync(file, "utf8")))
  .map((file) => file.slice(REPO_ROOT.length).replace(/\\/g, "/"))
  .sort();

describe("deal_stage_history de-dup contract (repo-wide)", () => {
  it("every history-writer in the repo is classified (new ones must be added here)", () => {
    expect(found).toEqual([...TRIGGER_FIRING, ...FLAG_EXEMPT].sort());
  });

  it("every trigger-firing path suppresses the 0143 backstop", () => {
    for (const rel of TRIGGER_FIRING) {
      const src = readFileSync(new URL(`../../../../${rel}`, import.meta.url), "utf8");
      expect(src, `${rel} must set app.skip_stage_history_trigger`).toContain(
        "app.skip_stage_history_trigger"
      );
    }
  });
});
