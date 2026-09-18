// scope_title survives the whole loop against a REAL Postgres: create -> read -> edit -> read.
//
// A column can exist, a type can compile, a route can forward the field, and the value can still never
// reach a screen — the read projection is a separate decision from the write. This runs the ACTUAL
// service functions (createDeal, getDealById, getDealDetail's gate, updateDeal, getDeals) against PGlite
// with the schema derived from the REAL Drizzle table definitions, so every one of those links is
// exercised rather than asserted about:
//
//   create  — createDeal's insert carries scopeTitle into the row
//   read    — getDealById projects it back (getTableColumns(deals), the detail page's source)
//   edit    — updateDeal's allowlist writes a NEW value, and only when the caller supplies the key
//   read    — the new value is what comes back, and an untouched partial save does not blank it
//   list    — getDeals projects it too, which is what the CSV export reads
//
// Only the pieces that require the GLOBAL db connection (pipeline stage config) or fire side effects
// (assignment tasks) are mocked; everything on the deal write/read path is the shipping code.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { eq } from "drizzle-orm";
import {
  activities,
  auditLog,
  companies,
  dealHistory,
  deals,
  leads,
  pipelineStageConfig,
  userOfficeAccess,
  users,
} from "@trock-crm/shared/schema";
import { tenantSchemaSql } from "../../helpers/tenant-schema-from-drizzle.js";

const STAGE_ID = "00000000-0000-4000-8000-0000000050a1";
const REP_ID = "00000000-0000-4000-8000-0000000000a1";
const OFFICE_ID = "00000000-0000-4000-8000-0000000000f1";

const STAGE = {
  id: STAGE_ID,
  slug: "opportunity",
  name: "Opportunity",
  workflowFamily: "standard_deal",
  displayOrder: 1,
  isBidBoard: false,
  isTerminal: false,
  isActive: true,
  bidBoardStageCode: null,
};

// getStageById / getStageByIdForWorkflowRoute read pipeline_stage_config through the GLOBAL db
// connection, not tenantDb, so they cannot see PGlite. Everything else below is the real thing.
vi.mock("../../../src/modules/pipeline/service.js", () => ({
  getStageById: vi.fn().mockResolvedValue(STAGE),
  getStageBySlug: vi.fn().mockResolvedValue(STAGE),
  getStageByIdForWorkflowRoute: vi.fn().mockResolvedValue(STAGE),
  getActiveProjectTypes: vi.fn().mockResolvedValue([]),
  resolveActiveProjectTypeValue: vi.fn().mockResolvedValue(null),
  listDealStages: vi.fn().mockResolvedValue([STAGE]),
}));

vi.mock("../../../src/modules/assignment-tasks/service.js", () => ({
  createAssignmentTaskIfNeeded: vi.fn(),
}));

const { createDeal, getDealById, getDeals, updateDeal } = await import(
  "../../../src/modules/deals/service.js"
);

let pg: PGlite;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let tdb: any;

beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(`SET TimeZone='UTC';`);
  await pg.exec(
    tenantSchemaSql("public", [
      users,
      userOfficeAccess,
      pipelineStageConfig,
      companies,
      // getDeals LEFT JOINs leads to resolve the effective bid-due date.
      leads,
      deals,
      dealHistory,
      activities,
      auditLog,
    ]),
  );
  // Not a Drizzle table — projectNumber.ts reserves the daily suffix with raw SQL. DDL copied from the
  // migration that creates it (0068_office_code_and_dealnumber_fix.sql).
  await pg.exec(`
    CREATE TABLE IF NOT EXISTS public.deal_number_daily_sequences (
      day_key text PRIMARY KEY,
      last_suffix text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT NOW(),
      updated_at timestamptz NOT NULL DEFAULT NOW()
    );
    -- The deal projections resolve the configured project-type digit through this table (it is what the
    -- At Risk service split reads), so every fixture exercising them needs it present.
    CREATE TABLE IF NOT EXISTS public.project_type_config (
      id uuid PRIMARY KEY,
      name text NOT NULL,
      code text
    );
  `);
  await pg.query(
    `INSERT INTO public.pipeline_stage_config (id, slug, name, display_order) VALUES ($1, $2, $3, 1)`,
    [STAGE_ID, "opportunity", "Opportunity"],
  );
  await pg.query(
    `INSERT INTO public.users (id, email, display_name, role, office_id, is_active)
     VALUES ($1, $2, $3, 'rep', $4, true)`,
    [REP_ID, "rep@example.com", "Rep One", OFFICE_ID],
  );
  tdb = drizzle(pg);
}, 30000);

afterAll(async () => {
  await pg?.close?.();
});

beforeEach(async () => {
  await pg.exec(`DELETE FROM public.deals; DELETE FROM public.deal_number_daily_sequences;`);
});

async function create(scopeTitle: string | null | undefined) {
  return createDeal(tdb, {
    name: "SMOKE TEST DELETE scope-title round trip",
    stageId: STAGE_ID,
    assignedRepId: REP_ID,
    actorUserId: REP_ID,
    actorRole: "rep",
    officeId: OFFICE_ID,
    officeCode: "dfw",
    migrationMode: true, // skips the company/property lineage requirement; irrelevant to scope_title
    ...(scopeTitle === undefined ? {} : { scopeTitle }),
  });
}

/** The read the deal-detail page performs. */
function read(dealId: string) {
  return getDealById(tdb, dealId, "rep", REP_ID);
}

describe("scope_title round trip (real SQL): create -> read -> edit -> read", () => {
  it("carries a title through creation and reads it back", async () => {
    const created = await create("Balcony Repair");
    expect(created.scopeTitle).toBe("Balcony Repair");

    const readBack = await read(created.id);
    expect(readBack?.scopeTitle).toBe("Balcony Repair");

    // …and it really is in the column, not just in the returning row.
    const [row] = await tdb.select({ scopeTitle: deals.scopeTitle }).from(deals).where(eq(deals.id, created.id));
    expect(row.scopeTitle).toBe("Balcony Repair");
  });

  it("edits the title and reads the NEW value back", async () => {
    const created = await create("Interior Repair");

    const updated = await updateDeal(
      tdb,
      created.id,
      { scopeTitle: "Unit Build Back" },
      "rep",
      REP_ID,
      OFFICE_ID,
    );
    expect(updated.scopeTitle).toBe("Unit Build Back");
    expect((await read(created.id))?.scopeTitle).toBe("Unit Build Back");
  });

  it("clears the title on an explicit null", async () => {
    const created = await create("Plumbing Renovations");

    await updateDeal(tdb, created.id, { scopeTitle: null }, "rep", REP_ID, OFFICE_ID);

    expect((await read(created.id))?.scopeTitle).toBeNull();
  });

  it("leaves an existing title ALONE when the patch does not mention it", async () => {
    // The deal form saves a partial payload. If updateDeal keyed on falsiness instead of `!== undefined`,
    // every unrelated save (a win-probability tweak, a close-date correction) would silently wipe the
    // title accounting had just filled in.
    const created = await create("Exterior Renovation");

    await updateDeal(tdb, created.id, { winProbability: 55 }, "rep", REP_ID, OFFICE_ID);

    expect((await read(created.id))?.scopeTitle).toBe("Exterior Renovation");
  });

  it("creates with NULL when the caller omits the field entirely", async () => {
    const created = await create(undefined);
    expect(created.scopeTitle).toBeNull();
    expect((await read(created.id))?.scopeTitle).toBeNull();
  });

  it("projects the title on the LIST read too — the export reads that payload, not the detail one", async () => {
    await create("Balcony Repair");

    const listed = await getDeals(tdb, { scope: "mine" }, "rep", REP_ID);

    expect(listed.deals).toHaveLength(1);
    expect(listed.deals[0]).toHaveProperty("scopeTitle", "Balcony Repair");
  });

  it("persists the title on the SERVICE-OPPORTUNITY create shape too, not just the standard one", async () => {
    // POST /deals/service-opportunity is a second, independent create path with its own explicit field
    // list on the route — it does NOT spread the body like POST /deals does, so a field can be accepted
    // by the validator and still be dropped on the way to createDeal. The route-level forwarding is
    // pinned in scope-title-api-cap.runtime.test.ts; this is the DB half of that same chain.
    const created = await createDeal(tdb, {
      name: "SMOKE TEST DELETE service opportunity scope title",
      stageId: STAGE_ID,
      assignedRepId: REP_ID,
      actorUserId: REP_ID,
      actorRole: "rep",
      officeId: OFFICE_ID,
      officeCode: "dfw",
      migrationMode: true,
      workflowRoute: "service",
      scopeTitle: "Clear backup clog from bathroom toilet unit 4350-201b",
    });

    expect(created.workflowRoute).toBe("service");
    expect((await read(created.id))?.scopeTitle).toBe(
      "Clear backup clog from bathroom toilet unit 4350-201b",
    );
  });

  it("stays editable on a BID-BOARD-OWNED deal — the only way a synced deal ever gets a title", async () => {
    // SyncHub/Procore ingest inserts deals directly and Procore has no scope-title equivalent, so every
    // bid-board-owned deal arrives with scope_title = NULL. The edit path is therefore the ONLY way one
    // ever gets a title. If scopeTitle were ever added to BID_BOARD_OWNED_UPDATE_FIELD_LABELS this would
    // 403 and the feature would be dead for the whole synced portfolio.
    const created = await create(null);
    await tdb.update(deals).set({ isBidBoardOwned: true }).where(eq(deals.id, created.id));

    const updated = await updateDeal(
      tdb,
      created.id,
      { scopeTitle: "Exterior Renovation" },
      "rep",
      REP_ID,
      OFFICE_ID,
    );

    expect(updated.scopeTitle).toBe("Exterior Renovation");
  });

  it("records the change in the deal's audit trail", async () => {
    // scope_title is a field accounting relies on; a silent overwrite has to be traceable to whoever
    // did it, the same as name/description/awarded_amount.
    await tdb.delete(auditLog);
    const created = await create("Interior Repair");
    await updateDeal(
      tdb,
      created.id,
      {
        scopeTitle: "Balcony Repair",
        auditContext: {
          actor: { type: "user", userId: REP_ID, name: "Rep One", role: "rep" },
          ipAddress: null,
          userAgent: null,
        },
      },
      "rep",
      REP_ID,
      OFFICE_ID,
    );

    const rows = await tdb.select().from(auditLog);
    const changes = rows
      .map((row: { changes: unknown }) => row.changes as Record<string, unknown> | null)
      .filter((c: Record<string, unknown> | null): c is Record<string, unknown> => c != null);
    const scopeChange = changes.find((c: Record<string, unknown>) => "scopeTitle" in c);

    expect(scopeChange?.scopeTitle).toEqual({ from: "Interior Repair", to: "Balcony Repair" });
  });
});
