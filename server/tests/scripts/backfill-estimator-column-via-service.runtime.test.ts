// Real-types (PGlite + Drizzle-derived schema) test of the ESTIMATOR-COLUMN service backfill: candidate
// selection (NULL estimator_user_id + populated free-text estimator + NO bid_board_estimator), name
// resolution via the curated map, arg parsing, the office-schema regex guard, a faithful dry-run that
// writes NOTHING, an execute that assigns the column AND mints the additive estimator commission row via
// setDealEstimator, and the guard SKIPS (change order, sales-source conflict, Bid-Board first-fill) that
// setDealEstimator throws — proving those are counted as skips and NOT linked.
import { afterAll, beforeAll, beforeEach, afterEach, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import {
  auditLog,
  dealSignedCommissions,
  deals,
  offices,
  pipelineStageConfig,
  userCommissionSettings,
  userOfficeAccess,
  users,
} from "@trock-crm/shared/schema";
import { tenantSchemaSql } from "../helpers/tenant-schema-from-drizzle.js";
import {
  CANDIDATE_COLUMN_SQL,
  OFFICE_SCHEMA_RE_test as officeSchemaOk,
  backfillTenantEstimatorColumn,
  findEstimatorColumnRows,
  parseArgs,
  resolveCandidates,
  runOne,
} from "../../src/scripts/backfill-estimator-column-via-service.js";

const U = (s: string) => `00000000-0000-4000-8000-${s.padStart(12, "0")}`;
const OFFICE = U("0f01");
const OTHER_OFFICE = U("0f02");
const O1 = U("0001"); // owner/rep, rate 0.03
const EST_TIM = U("0002"); // estimator "Tim", rate 0.02, in OFFICE
const EST_ALEX = U("0003"); // estimator "alex", rate 0.05, in OFFICE
const EST_OTHER = U("0004"); // estimator "colby", rate 0.04, in OTHER_OFFICE only (no grant) -> office access skip
const SRC = U("0005"); // a sales source rep
const ACTOR = U("0ac7"); // backfill operator (created_by + audit actor)
const WON = U("0500");

// Candidate deals (NULL estimator_user_id, populated free-text estimator, NULL bid_board_estimator):
const D_TIM = U("0de1"); // estimator="Tim" -> EST_TIM, plain -> ASSIGNED
const D_ALEX = U("0de2"); // estimator="alex" -> EST_ALEX, plain -> ASSIGNED
const D_UNRESOLVED = U("0de3"); // estimator="Zzunknown" -> no map entry -> skipped:unresolved
const D_CO = U("0de4"); // is_change_order=true, estimator="Tim" -> skipped:CHANGE_ORDER_FIELD_LOCKED
const D_SRC_CONFLICT = U("0de5"); // estimator="alex" but EST_ALEX is the sales source -> SALES_SOURCE_CONFLICT
const D_BB_FIRSTFILL = U("0de6"); // is_bid_board_owned=true, estimator NULL currently -> BID_BOARD_OWNED_ESTIMATOR_LOCKED
const D_OFFICE_DENIED = U("0de7"); // estimator="colby" -> EST_OTHER (no access to OFFICE) -> skipped:http_400

// Non-candidates (must NOT be scanned):
const D_ALREADY_LINKED = U("0dea"); // estimator_user_id already set -> excluded (IS NULL predicate)
const D_HAS_BB = U("0deb"); // bid_board_estimator populated -> excluded (BB name is the sync's)
const D_NO_TEXT = U("0dec"); // estimator column blank -> excluded

let pg: PGlite;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let tdb: any;
const query = (sql: string, params?: unknown[]) =>
  pg.query(sql, params as never[]) as Promise<{ rows: Record<string, unknown>[] }>;

async function estimatorUserId(dealId: string): Promise<string | null> {
  const r = await pg.query<{ estimator_user_id: string | null }>(
    `SELECT estimator_user_id FROM public.deals WHERE id='${dealId}'`
  );
  return r.rows[0]?.estimator_user_id ?? null;
}
async function dscCountForRep(dealId: string, rep: string): Promise<number> {
  return (await pg.query(`SELECT 1 FROM public.deal_signed_commissions WHERE deal_id='${dealId}' AND rep_user_id='${rep}'`))
    .rows.length;
}

// The curated resolution map the ingest uses — first-name-only variants, as in prod.
const MAP = JSON.stringify({ Tim: EST_TIM, alex: EST_ALEX, colby: EST_OTHER });

beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(
    tenantSchemaSql("public", [
      users,
      offices,
      userOfficeAccess,
      pipelineStageConfig,
      deals,
      userCommissionSettings,
      dealSignedCommissions,
      auditLog,
    ])
  );
  // The (deal_id, rep_user_id) UNIQUE backs the mint's ON CONFLICT DO NOTHING; tenantSchemaSql omits it.
  await pg.exec(
    `ALTER TABLE public.deal_signed_commissions ADD CONSTRAINT deal_signed_commissions_dedup UNIQUE (deal_id, rep_user_id);`
  );
  tdb = drizzle(pg);

  await pg.exec(`INSERT INTO public.offices (id, name, slug) VALUES
    ('${OFFICE}','Dallas','dallas'), ('${OTHER_OFFICE}','Atlanta','atlanta')`);
  await pg.exec(`INSERT INTO public.users (id, display_name, email, role, office_id, is_active) VALUES
    ('${O1}','Owner One','o1@x.com','rep','${OFFICE}',true),
    ('${EST_TIM}','Tim Estimator','tim@x.com','rep','${OFFICE}',true),
    ('${EST_ALEX}','Alex Estimator','alex@x.com','rep','${OFFICE}',true),
    ('${EST_OTHER}','Colby Estimator','colby@x.com','rep','${OTHER_OFFICE}',true),
    ('${SRC}','Source Rep','src@x.com','rep','${OFFICE}',true)`);
  await pg.exec(`INSERT INTO public.pipeline_stage_config (id, name, slug, display_order) VALUES
    ('${WON}','Won','won',9)`);
  await pg.exec(`INSERT INTO public.user_commission_settings (user_id, commission_rate, is_active) VALUES
    ('${O1}',0.030000,true), ('${EST_TIM}',0.020000,true), ('${EST_ALEX}',0.050000,true),
    ('${EST_OTHER}',0.040000,true), ('${SRC}',0.030000,true)`);

  // deals: owner O1, signed, WON. estimator = free-text column; estimator_user_id NULL unless noted.
  const ins = (
    id: string,
    estimatorText: string | null,
    opts: {
      estimatorUserId?: string;
      bidBoardEstimator?: string;
      isChangeOrder?: boolean;
      isBidBoardOwned?: boolean;
      salesSourceUserId?: string;
    } = {}
  ) =>
    `INSERT INTO public.deals
       (id, deal_number, name, stage_id, assigned_rep_id, estimator, estimator_user_id, bid_board_estimator,
        awarded_amount, contract_signed_date, is_change_order, is_bid_board_owned, sales_source_user_id, is_active, workflow_route)
     VALUES
       ('${id}','${id.slice(-4)}','Deal','${WON}','${O1}',
        ${estimatorText == null ? "NULL" : `'${estimatorText}'`},
        ${opts.estimatorUserId ? `'${opts.estimatorUserId}'` : "NULL"},
        ${opts.bidBoardEstimator ? `'${opts.bidBoardEstimator}'` : "NULL"},
        100000, '2026-01-15', ${opts.isChangeOrder ?? false}, ${opts.isBidBoardOwned ?? false},
        ${opts.salesSourceUserId ? `'${opts.salesSourceUserId}'` : "NULL"}, true, 'service')`;

  await pg.exec(ins(D_TIM, "Tim"));
  await pg.exec(ins(D_ALEX, "alex"));
  await pg.exec(ins(D_UNRESOLVED, "Zzunknown"));
  await pg.exec(ins(D_CO, "Tim", { isChangeOrder: true }));
  await pg.exec(ins(D_SRC_CONFLICT, "alex", { salesSourceUserId: EST_ALEX }));
  await pg.exec(ins(D_BB_FIRSTFILL, "Tim", { isBidBoardOwned: true }));
  await pg.exec(ins(D_OFFICE_DENIED, "colby"));
  // Non-candidates:
  await pg.exec(ins(D_ALREADY_LINKED, "Tim", { estimatorUserId: EST_TIM }));
  await pg.exec(ins(D_HAS_BB, "Tim", { bidBoardEstimator: "Tim" }));
  await pg.exec(ins(D_NO_TEXT, null));

  // Seed the OWNER commission row on the deals we expect to ASSIGN, so the estimator mint's owner-row
  // invariant is satisfied (the additive estimator row must sit on top of an existing owner row).
  await pg.exec(
    `INSERT INTO public.deal_signed_commissions
       (deal_id, rep_user_id, attribution_role, source_value_kind, source_value_amount, applied_rate, amount, contract_signed_date_at_signing) VALUES
       ('${D_TIM}','${O1}','owner','awarded_amount',100000,0.030000,3000,'2026-01-15'),
       ('${D_ALEX}','${O1}','owner','awarded_amount',100000,0.030000,3000,'2026-01-15')`
  );
}, 30_000);

afterAll(async () => {
  await pg?.close();
});

// Every commit-writing test runs inside an OUTER savepoint the harness rolls back in afterEach, so the
// shared PGlite instance is never mutated across tests (mirrors the isolation the sibling gets from its
// candidate query re-selecting fresh each time). Set the resolution map for the whole suite.
beforeEach(() => {
  process.env.BID_BOARD_ESTIMATOR_USER_MAP = MAP;
});
afterEach(() => {
  delete process.env.BID_BOARD_ESTIMATOR_USER_MAP;
});

describe("estimator-column service backfill — candidate selection + resolution", () => {
  it("selects only NULL-estimator_user_id, populated-estimator, no-bid_board_estimator deals", async () => {
    const rows = await findEstimatorColumnRows(query);
    const ids = rows.map((r) => r.dealId).sort();
    expect(ids).toEqual(
      [D_TIM, D_ALEX, D_UNRESOLVED, D_CO, D_SRC_CONFLICT, D_BB_FIRSTFILL, D_OFFICE_DENIED].sort()
    );
    expect(ids).not.toContain(D_ALREADY_LINKED); // estimator_user_id already set
    expect(ids).not.toContain(D_HAS_BB); // bid_board_estimator populated
    expect(ids).not.toContain(D_NO_TEXT); // estimator column blank
  });

  it("candidate SQL is column-only (no user input, safe to interpolate)", () => {
    expect(CANDIDATE_COLUMN_SQL).toContain("estimator_user_id IS NULL");
    expect(CANDIDATE_COLUMN_SQL).toContain("NULLIF(BTRIM(estimator), '') IS NOT NULL");
    expect(CANDIDATE_COLUMN_SQL).toContain("NULLIF(BTRIM(bid_board_estimator), '') IS NULL");
  });

  it("resolves free-text names via the curated map; drops unmapped names as unresolved", async () => {
    const rows = await findEstimatorColumnRows(query);
    const { resolved, unresolved } = resolveCandidates(rows);
    const resolvedByDeal = Object.fromEntries(resolved.map((c) => [c.dealId, c.resolvedUserId]));
    expect(resolvedByDeal[D_TIM]).toBe(EST_TIM);
    expect(resolvedByDeal[D_ALEX]).toBe(EST_ALEX);
    expect(resolvedByDeal[D_OFFICE_DENIED]).toBe(EST_OTHER);
    expect(unresolved.map((r) => r.dealId)).toEqual([D_UNRESOLVED]);
  });

  it("with the map UNSET, nothing resolves (inert until BID_BOARD_ESTIMATOR_USER_MAP is configured)", async () => {
    delete process.env.BID_BOARD_ESTIMATOR_USER_MAP;
    const rows = await findEstimatorColumnRows(query);
    const { resolved, unresolved } = resolveCandidates(rows);
    expect(resolved).toHaveLength(0);
    expect(unresolved.length).toBe(rows.length);
  });
});

describe("estimator-column service backfill — dry-run vs commit via setDealEstimator", () => {
  it("dry-run (default) reports faithful outcomes but writes NOTHING", async () => {
    const summary = await backfillTenantEstimatorColumn(tdb, query, {
      schema: "public",
      execute: false,
      actorUserId: ACTOR,
      officeId: OFFICE,
    });
    // Two plain assigns previewed; each guard case previewed as its skip.
    expect(summary.byStatus["assigned"]).toBe(2); // D_TIM + D_ALEX
    expect(summary.byStatus["skipped:CHANGE_ORDER_FIELD_LOCKED"]).toBe(1); // D_CO
    expect(summary.byStatus["skipped:SALES_SOURCE_CONFLICT"]).toBe(1); // D_SRC_CONFLICT
    expect(summary.byStatus["skipped:BID_BOARD_OWNED_ESTIMATOR_LOCKED"]).toBe(1); // D_BB_FIRSTFILL
    expect(summary.byStatus["skipped:http_400"]).toBe(1); // D_OFFICE_DENIED (validateAssignee, code-less)
    expect(summary.byStatus["skipped:unresolved"]).toBe(1); // D_UNRESOLVED (one bucket)
    // NOTHING persisted — columns still NULL, no estimator rows minted.
    expect(await estimatorUserId(D_TIM)).toBeNull();
    expect(await estimatorUserId(D_ALEX)).toBeNull();
    expect(await dscCountForRep(D_TIM, EST_TIM)).toBe(0);
    expect(await dscCountForRep(D_ALEX, EST_ALEX)).toBe(0);
  });

  it("commit assigns the column AND mints the additive estimator commission via the service; is idempotent", async () => {
    // Isolate the mutation in an outer transaction so the shared instance survives (setDealEstimator's own
    // per-candidate transaction nests as a savepoint inside this BEGIN). ROLLBACK in finally undoes it all.
    await pg.exec("BEGIN");
    try {
      const run1 = await backfillTenantEstimatorColumn(tdb, query, {
        schema: "public",
        execute: true,
        actorUserId: ACTOR,
        officeId: OFFICE,
      });
      expect(run1.byStatus["assigned"]).toBe(2);
      // Guard skips still classified, run not aborted.
      expect(run1.byStatus["skipped:CHANGE_ORDER_FIELD_LOCKED"]).toBe(1);
      expect(run1.byStatus["skipped:SALES_SOURCE_CONFLICT"]).toBe(1);
      expect(run1.byStatus["skipped:BID_BOARD_OWNED_ESTIMATOR_LOCKED"]).toBe(1);
      expect(run1.byStatus["skipped:http_400"]).toBe(1);
      expect(run1.byStatus["skipped:unresolved"]).toBe(1);

      // Columns now linked, estimator rows minted on top of the untouched owner rows.
      expect(await estimatorUserId(D_TIM)).toBe(EST_TIM);
      expect(await estimatorUserId(D_ALEX)).toBe(EST_ALEX);
      expect(await dscCountForRep(D_TIM, EST_TIM)).toBe(1);
      expect(await dscCountForRep(D_ALEX, EST_ALEX)).toBe(1);
      expect(await dscCountForRep(D_TIM, O1)).toBe(1); // owner row untouched

      // Amount + created_by prove the service minted it: 100000 × 0.02 (Tim's rate), operator as created_by.
      const estRow = (
        await pg.query<{ amount: string; created_by: string }>(
          `SELECT amount, created_by FROM public.deal_signed_commissions WHERE deal_id='${D_TIM}' AND rep_user_id='${EST_TIM}'`
        )
      ).rows[0];
      expect(Number(estRow.amount)).toBe(2000);
      expect(estRow.created_by).toBe(ACTOR);

      // Guard cases never linked.
      expect(await estimatorUserId(D_CO)).toBeNull();
      expect(await estimatorUserId(D_SRC_CONFLICT)).toBeNull();
      expect(await estimatorUserId(D_BB_FIRSTFILL)).toBeNull();
      expect(await estimatorUserId(D_OFFICE_DENIED)).toBeNull();

      // Re-run: the assigned deals now have estimator_user_id set, so they drop out of the candidate set.
      const run2 = await backfillTenantEstimatorColumn(tdb, query, {
        schema: "public",
        execute: true,
        actorUserId: ACTOR,
        officeId: OFFICE,
      });
      expect(run2.byStatus["assigned"] ?? 0).toBe(0);
      expect(run2.rows.some((r) => r.dealId === D_TIM)).toBe(false);
      expect(await dscCountForRep(D_TIM, EST_TIM)).toBe(1); // no duplicate estimator row
    } finally {
      await pg.exec("ROLLBACK");
    }
  });

  it("runOne classifies a change-order candidate as a skip, never an assign", async () => {
    const rows = await findEstimatorColumnRows(query);
    const co = resolveCandidates(rows).resolved.find((c) => c.dealId === D_CO)!;
    const status = await runOne(tdb, co, ACTOR, OFFICE, false); // dry-run
    expect(status).toBe("skipped:CHANGE_ORDER_FIELD_LOCKED");
  });

  it("runOne re-checks under the row lock and NEVER overwrites a concurrently-set estimator", async () => {
    // D_ALREADY_LINKED currently has estimator_user_id = EST_TIM. Hand runOne a candidate that (via the
    // service's correction path) WOULD reassign it to EST_ALEX — simulating an estimator assigned between the
    // unlocked scan and this call. The lock+recheck must SKIP it as no_change and leave EST_TIM in place, so
    // no clobber and no commission re-attribution. (Without the recheck, setDealEstimator would happily
    // overwrite it and return "assigned".)
    await pg.exec("BEGIN");
    try {
      const candidate = { dealId: D_ALREADY_LINKED, dealNumber: "dea", estimatorText: "alex", resolvedUserId: EST_ALEX };
      const status = await runOne(tdb, candidate, ACTOR, OFFICE, true); // execute
      expect(status).toBe("skipped:no_change");
      expect(await estimatorUserId(D_ALREADY_LINKED)).toBe(EST_TIM); // untouched — not overwritten to EST_ALEX
      expect(await dscCountForRep(D_ALREADY_LINKED, EST_ALEX)).toBe(0); // no re-attributed commission
    } finally {
      await pg.exec("ROLLBACK");
    }
  });

  it("counts EVERY unresolved candidate under skipped:unresolved, not just once", async () => {
    // The fixture has one unmapped name (D_UNRESOLVED); add two more so the count must be 3, not 1.
    const insUnresolved = (id: string, text: string) =>
      `INSERT INTO public.deals
         (id, deal_number, name, stage_id, assigned_rep_id, estimator, estimator_user_id, bid_board_estimator,
          awarded_amount, contract_signed_date, is_change_order, is_bid_board_owned, sales_source_user_id, is_active, workflow_route)
       VALUES ('${id}','${id.slice(-4)}','Deal','${WON}','${O1}','${text}',NULL,NULL,100000,'2026-01-15',false,false,NULL,true,'service')`;
    await pg.exec("BEGIN");
    try {
      await pg.exec(insUnresolved(U("0de8"), "Qqunknown"));
      await pg.exec(insUnresolved(U("0de9"), "Wwunknown"));
      const summary = await backfillTenantEstimatorColumn(tdb, query, {
        schema: "public",
        execute: false,
        actorUserId: ACTOR,
        officeId: OFFICE,
      });
      expect(summary.unresolved).toBe(3); // D_UNRESOLVED + 2 new
      expect(summary.byStatus["skipped:unresolved"]).toBe(3); // bumped per row, not once
    } finally {
      await pg.exec("ROLLBACK");
    }
  });
});

describe("estimator-column service backfill — parseArgs + schema guard", () => {
  it("rejects the space-separated --tenant form (would silently widen to ALL tenants)", () => {
    expect(() => parseArgs(["--tenant", "office_dallas"])).toThrow(/with '='/);
  });
  it("rejects an empty --tenant= value", () => {
    expect(() => parseArgs(["--tenant="])).toThrow(/requires a value/);
  });
  it("requires --actor for --commit", () => {
    expect(() => parseArgs(["--commit"])).toThrow(/--commit requires --actor/);
  });
  it("rejects a non-UUID --actor", () => {
    expect(() => parseArgs(["--commit", "--actor=not-a-uuid"])).toThrow(/must be a UUID/);
  });
  it("rejects an unknown/misspelled flag before committing (would else widen --commit to ALL tenants)", () => {
    expect(() => parseArgs(["--commit", `--actor=${ACTOR}`, "--tennant=office_dallas"])).toThrow(/Unknown argument/);
  });
  it("accepts a valid --commit --actor=<uuid> --tenant=office_x", () => {
    const parsed = parseArgs(["--commit", `--actor=${ACTOR}`, "--tenant=office_dallas"]);
    expect(parsed).toEqual({ tenant: "office_dallas", execute: true, actorUserId: ACTOR });
  });
  it("defaults to a dry-run over all tenants with no args", () => {
    expect(parseArgs([])).toEqual({ tenant: null, execute: false, actorUserId: null });
  });
  it("OFFICE_SCHEMA_RE accepts office_* and rejects injection-y names", () => {
    expect(officeSchemaOk("office_dallas")).toBe(true);
    expect(officeSchemaOk("office_atlanta")).toBe(true);
    expect(officeSchemaOk("public")).toBe(false);
    expect(officeSchemaOk("office_dallas; DROP TABLE users")).toBe(false);
    expect(officeSchemaOk("Office_Dallas")).toBe(false);
  });
});
