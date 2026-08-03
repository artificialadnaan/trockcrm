// REAL-SQL (PGlite) proof that swapping the glasses-walkthrough routes' access gate relaxes exactly ONE
// dimension and no others.
//
// The routes used to assert with `getFieldProject`, whose query carries `activeProjectWhere()` — the field
// BROWSING rule. That rule is right for lists and detail pages and wrong for filing a recording, because a
// walk drains for hours or days after the visit and the deal can go Lost inside that window (see
// field-glasses-walkthrough-terminal-deal.test.ts for the route-level regression). They now assert with
// `assertAccessibleFieldCaptureTarget`, the gate the ordinary field PHOTO upload already uses.
//
// "One dimension" is a claim about SQL, and the two predicates are built from different sources — one is a
// hand-written `WHERE` over a stage join, the other a Drizzle select over `deals` — so nothing in the type
// system compares them. Only running both against the same rows does. Every case below therefore drives
// BOTH gates over one seeded deal and asserts they agree except on stage.
//
// A GUARD suite, not a regression one: both gates already behaved this way before the routes changed. What
// it pins is that they go on doing so — a later "tidy-up" that drops `is_active` from the capture-target
// gate would make Lost deals filable AND resurrect archived ones, and nothing else in the suite would see it.
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { deals, fieldUserStarredProjects, files, pipelineStageConfig } from "@trock-crm/shared/schema";
import { tenantSchemaSql } from "./helpers/tenant-schema-from-drizzle.js";
import {
  assertAccessibleFieldCaptureTarget,
  getFieldProject,
} from "../src/modules/field/projects-service.js";
import { LOST_STAGE_SLUGS, WON_STAGE_SLUGS } from "../src/modules/shared/pipeline-terminal-stages.js";

const U = (s: string) => `00000000-0000-4000-8000-${s.padStart(12, "0")}`;
const USER = U("22222");
const DEAL = U("11111");

// Read from the SHARED canonical families rather than typed in. A hardcoded "closed_lost" would keep this
// suite green against a rename that had already broken the predicate it exists to describe.
const LOST_SLUG = LOST_STAGE_SLUGS[0]!;
const WON_SLUG = WON_STAGE_SLUGS[0]!;
const ACTIVE_SLUG = "estimating";

const STAGE = { active: U("a1"), lost: U("a2"), won: U("a3") };

let pg: PGlite;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let tenantDb: any;

beforeAll(async () => {
  pg = new PGlite();
  // `files` and `field_user_starred_projects` are here only because getFieldProject LEFT JOINs them for
  // photoCount/starred; nothing in these cases reads either. `pipeline_stage_config` is the one that
  // matters — `activeProjectWhere` decides everything from `psc.is_terminal` and `psc.slug`.
  await pg.exec(tenantSchemaSql("public", [deals, files, fieldUserStarredProjects, pipelineStageConfig]));
  tenantDb = drizzle(pg);

  await tenantDb.insert(pipelineStageConfig).values([
    { id: STAGE.active, name: "Estimating", slug: ACTIVE_SLUG, displayOrder: 1, isTerminal: false },
    { id: STAGE.lost, name: "Closed Lost", slug: LOST_SLUG, displayOrder: 2, isTerminal: true },
    { id: STAGE.won, name: "Closed Won", slug: WON_SLUG, displayOrder: 3, isTerminal: true },
  ]);
});

afterAll(async () => {
  await pg.close();
});

beforeEach(async () => {
  await pg.exec("DELETE FROM deals");
});

async function seedDeal(stageId: string, isActive = true): Promise<void> {
  await tenantDb.insert(deals).values({
    id: DEAL,
    dealNumber: "DFW-0001",
    name: "North wing re-roof",
    stageId,
    isActive,
  });
}

const access = { userId: USER, userRole: "field_contractor" as const };

/** Both gates, run over the same row, reduced to "did it let this through". */
async function gateOutcomes(): Promise<{ browsable: boolean; filable: boolean }> {
  const browsable = await getFieldProject(tenantDb, access, DEAL).then(
    () => true,
    () => false,
  );
  const filable = await assertAccessibleFieldCaptureTarget(tenantDb, { dealId: DEAL, ...access }).then(
    () => true,
    () => false,
  );
  return { browsable, filable };
}

describe("the gate a glasses walkthrough is filed through vs. the gate the field browses through", () => {
  it("parts company on exactly one deal: active record, LOST stage — not browsable, still filable", async () => {
    // The whole finding, in one row. A walk recorded while this deal was live and still draining after it
    // moved to Lost was refused by the browsing gate, and a site visit is not repeatable.
    await seedDeal(STAGE.lost);
    expect(await gateOutcomes()).toEqual({ browsable: false, filable: true });
  });

  it("agrees on an ACTIVE-pipeline deal — the ordinary walk, unaffected either way", async () => {
    await seedDeal(STAGE.active);
    expect(await gateOutcomes()).toEqual({ browsable: true, filable: true });
  });

  it("agrees on a WON deal — terminal, but crews work in-production jobs and both gates already allowed it", async () => {
    await seedDeal(STAGE.won);
    expect(await gateOutcomes()).toEqual({ browsable: true, filable: true });
  });

  it.each([
    ["an ARCHIVED (is_active = false) deal", STAGE.active],
    ["an ARCHIVED deal that is also LOST", STAGE.lost],
  ])("still refuses %s through BOTH gates — is_active is not what was relaxed", async (_label, stageId) => {
    // The line that must not move. `is_active = false` is the CRM's soft delete, and a gate that dropped
    // it would let a field user attach evidence to a record the CRM has already retired — which is a
    // different and much larger relaxation than the stage one, wearing the same shape.
    await seedDeal(stageId, false);
    expect(await gateOutcomes()).toEqual({ browsable: false, filable: false });
  });

  it("still refuses a deal that does not exist through BOTH gates", async () => {
    expect(await gateOutcomes()).toEqual({ browsable: false, filable: false });
  });
});
