// Real-SQL (PGlite + the Drizzle-derived tenant schema) proof of "Move back to Opportunity".
//
// Everything that WRITES is real here: the detach UPDATE, the RFP-cycle reset, removeCommissionForDeal,
// changeDealStage's stage_history/terminal-field clear, the audit_log rows and the deal_history row. Only
// the two things that read the GLOBAL (non-tenant) pipeline config connection are stubbed —
// pipeline/service.js and the stage gate — matching the existing stage-change test's seam. The gate's
// backward-move permission rule is proven separately as a pure function in
// shared/src/types/return-to-opportunity.test.ts and by the role cases below, which run the REAL
// eligibility evaluation inside the service.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import {
  auditLog,
  dealApprovals,
  dealChangeOrders,
  dealHistory,
  dealSignedCommissions,
  dealStageHistory,
  deals,
  jobQueue,
  offices,
  tasks,
  userCommissionSettings,
  users,
} from "@trock-crm/shared/schema";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { tenantSchemaSql } from "../../helpers/tenant-schema-from-drizzle.js";

const U = (s: string) => `00000000-0000-4000-8000-${s.padStart(12, "0")}`;
const OFFICE = U("0f1");
const ADMIN = U("0aad");
const DIRECTOR = U("0d10");
const REP = U("0a01");

const OPP_STAGE = U("5001");
const ESTIMATING_STAGE = U("5002");
const WON_STAGE = U("5003");

const STAGES: Record<string, {
  id: string;
  name: string;
  slug: string;
  displayOrder: number;
  isTerminal: boolean;
  isActivePipeline: boolean;
  workflowFamily: string;
}> = {
  [OPP_STAGE]: { id: OPP_STAGE, name: "Opportunity", slug: "opportunity", displayOrder: 2, isTerminal: false, isActivePipeline: true, workflowFamily: "standard_deal" },
  [ESTIMATING_STAGE]: { id: ESTIMATING_STAGE, name: "Estimating", slug: "estimating", displayOrder: 3, isTerminal: false, isActivePipeline: true, workflowFamily: "standard_deal" },
  [WON_STAGE]: { id: WON_STAGE, name: "Won", slug: "won", displayOrder: 7, isTerminal: true, isActivePipeline: true, workflowFamily: "standard_deal" },
};

vi.mock("../../../src/modules/pipeline/service.js", () => ({
  getStageById: vi.fn(async (id: string) => STAGES[id] ?? null),
  getStageBySlug: vi.fn(async (slug: string) =>
    Object.values(STAGES).find((stage) => stage.slug === slug) ?? null
  ),
}));

vi.mock("../../../src/modules/deals/scoping-service.js", () => ({
  activateDealScopingIntake: vi.fn(),
  evaluateDealScopingReadiness: vi.fn(),
}));

vi.mock("../../../src/modules/deals/timer-service.js", () => ({
  createStageTimers: vi.fn(),
}));

vi.mock("../../../src/modules/deals/stage-gate.js", async (importActual) => ({
  ...(await importActual<typeof import("../../../src/modules/deals/stage-gate.js")>()),
  validateStageGate: vi.fn(),
}));

const { validateStageGate } = await import("../../../src/modules/deals/stage-gate.js");
const { returnDealToOpportunity, previewReturnToOpportunity } = await import(
  "../../../src/modules/deals/return-to-opportunity-service.js"
);
const { changeDealStage } = await import("../../../src/modules/deals/stage-change.js");
const { buildBidBoardOwnershipState } = await import("../../../src/modules/deals/service.js");

let pg: PGlite;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let tdb: any;

const auditContext = {
  actor: { type: "user" as const, userId: ADMIN, name: "Ada Admin", role: "admin" as const },
  ipAddress: "127.0.0.1",
  userAgent: "vitest",
};

/** A fully bid-board-owned, RFP-approved deal parked in estimating — the shape the button targets. */
async function seedBidBoardDeal(
  id: string,
  opts: {
    stageId?: string;
    contractSignedDate?: string | null;
    wonClosedDate?: string | null;
    isChangeOrder?: boolean;
    parentDealId?: string | null;
    isActive?: boolean;
  } = {}
) {
  const stageId = opts.stageId ?? ESTIMATING_STAGE;
  const signed = opts.contractSignedDate ?? null;
  await pg.exec(
    `INSERT INTO public.deals
       (id, deal_number, name, stage_id, assigned_rep_id, awarded_amount, bid_estimate,
        is_active, is_change_order, parent_deal_id, workflow_route, stage_entered_at,
        procore_company_id, procore_bid_id, synchub_bid_board_id, project_number,
        is_bid_board_owned, bid_board_stage_slug, bid_board_stage_family, bid_board_stage_status,
        bid_board_stage_entered_at, bid_board_mirror_source_entered_at,
        is_read_only_mirror, is_read_only_sync_dirty, read_only_synced_at,
        bid_board_linked_at, bid_board_project_number, bid_board_last_updated_at, bid_board_created_at,
        rfp_approval_status, rfp_approval_requested_at, rfp_approval_requested_by, rfp_approval_token,
        contract_signed_date, contract_signed_at, won_closed_date, actual_close_date,
        created_at, updated_at)
     VALUES ('${id}', 'D-${id.slice(-4)}', 'Palm Villas ${id.slice(-4)}', '${stageId}', '${REP}', 250000, 240000,
        ${opts.isActive === false ? "false" : "true"}, ${opts.isChangeOrder ? "true" : "false"},
        ${opts.parentDealId ? `'${opts.parentDealId}'` : "NULL"}, 'normal', now() - interval '20 days',
        '99000', 887766, 'sh-${id.slice(-4)}', 'DFW-4-11826-ab',
        true, 'estimating', 'estimating', 'Estimate in Progress',
        now() - interval '19 days', now() - interval '19 days',
        true, true, now() - interval '1 day',
        now() - interval '19 days', 'DFW-4-11826-ab', now() - interval '1 day', now() - interval '30 days',
        'approved', now() - interval '21 days', '${REP}', 'tok-${id.slice(-4)}',
        ${signed ? `'${signed}'` : "NULL"}, ${signed ? `'${signed}T00:00:00Z'` : "NULL"},
        ${opts.wonClosedDate ? `'${opts.wonClosedDate}'` : "NULL"},
        ${opts.wonClosedDate ? `'${opts.wonClosedDate}'` : "NULL"},
        now(), now())`
  );
}

async function seedCommission(dealId: string, repUserId: string, amount: string, role = "owner") {
  await pg.exec(
    `INSERT INTO public.deal_signed_commissions
       (deal_id, rep_user_id, attribution_role, source_value_kind, source_value_amount,
        applied_rate, amount, contract_signed_date_at_signing, created_by)
     VALUES ('${dealId}', '${repUserId}', '${role}', 'awarded_amount', 250000, 0.075000, ${amount},
             '2026-03-01', '${ADMIN}')`
  );
}

async function dealRow(id: string) {
  const { rows } = await pg.query<Record<string, unknown>>(
    `SELECT * FROM public.deals WHERE id = '${id}'`
  );
  return rows[0];
}

beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(`SET TimeZone='UTC';`);
  await pg.exec(
    tenantSchemaSql("public", [
      deals,
      dealSignedCommissions,
      dealStageHistory,
      dealApprovals,
      dealChangeOrders,
      dealHistory,
      jobQueue,
      tasks,
      auditLog,
      users,
      offices,
      userCommissionSettings,
    ])
  );
  await pg.exec(
    `ALTER TABLE public.deal_signed_commissions ADD CONSTRAINT deal_signed_commissions_dedup UNIQUE (deal_id, rep_user_id);`
  );
  tdb = drizzle(pg);

  for (const [id, role] of [[ADMIN, "admin"], [DIRECTOR, "director"], [REP, "rep"]] as const) {
    await pg.exec(
      `INSERT INTO public.users (id, email, display_name, role, office_id, is_active)
       VALUES ('${id}', '${id}@t.test', 'User ${id.slice(-4)}', '${role}', '${OFFICE}', true)`
    );
  }
}, 30_000);

afterAll(async () => {
  await pg?.close();
});

beforeEach(() => {
  vi.mocked(validateStageGate).mockReset();
  // Shape mirrors the real gate's verdict for an admin/director backward move into Opportunity.
  //
  // currentStage is read from the SEEDED ROW, never pinned to a constant: changeDealStage takes the
  // deal's current stage from the gate verdict, not from the row, and derives isReopen from
  // currentStage.isTerminal. Pinning it to Estimating would make isReopen false on exactly the
  // Won-deal cases that ARE a reopen in production, so the dealApprovals auto-invalidation (and the
  // Won-family branches keyed on the current stage) would never run under test.
  vi.mocked(validateStageGate).mockImplementation(async (_db, dealId, targetStageId) => {
    const { rows } = await pg.query<{ stage_id: string }>(
      `SELECT stage_id FROM public.deals WHERE id = '${dealId}'`
    );
    const currentStage = STAGES[rows[0]?.stage_id ?? ESTIMATING_STAGE] ?? STAGES[ESTIMATING_STAGE];
    return {
    allowed: true,
    isBackwardMove: true,
    isTerminal: false,
    targetStage: STAGES[targetStageId as string],
    currentStage,
    missingRequirements: {
      fields: [],
      documents: [],
      approvals: [],
      effectiveChecklist: { fields: [], attachments: [], approvals: [] },
    },
    effectiveChecklist: { fields: [], attachments: [], approvals: [] },
    requiresOverride: true,
    overrideType: "backward_move",
    blockReason: null,
    } as never;
  });
});

describe("returnDealToOpportunity — the detach", () => {
  it("severs every Bid Board binding, resets the whole RFP cycle, and lands at Opportunity", async () => {
    const D = U("d001");
    await seedBidBoardDeal(D);

    const result = await returnDealToOpportunity(tdb, {
      dealId: D,
      userId: ADMIN,
      userRole: "admin",
      reason: "Client pulled the scope; not ready to estimate.",
      auditContext,
    });

    expect(result.wasBidBoardLinked).toBe(true);
    const row = await dealRow(D);

    // Stage moved.
    expect(row.stage_id).toBe(OPP_STAGE);

    // The detach marker + who/when/why.
    expect(row.bid_board_detached_at).not.toBeNull();
    expect(row.bid_board_detached_by).toBe(ADMIN);
    expect(row.bid_board_detach_reason).toBe("Client pulled the scope; not ready to estimate.");

    // Every ownership / mirror / handoff column cleared.
    expect(row.is_bid_board_owned).toBe(false);
    expect(row.bid_board_stage_slug).toBeNull();
    expect(row.bid_board_stage_family).toBeNull();
    expect(row.bid_board_stage_status).toBeNull();
    expect(row.bid_board_stage_entered_at).toBeNull();
    expect(row.bid_board_mirror_source_entered_at).toBeNull();
    expect(row.is_read_only_mirror).toBe(false);
    expect(row.is_read_only_sync_dirty).toBe(false);
    expect(row.read_only_synced_at).toBeNull();
    // Scope-lock inputs — these two are what the plain backward move leaves behind, stranding the deal
    // permanently un-editable at Opportunity.
    expect(row.bid_board_linked_at).toBeNull();
    expect(row.bid_board_project_number).toBeNull();
    expect(row.bid_board_last_updated_at).toBeNull();

    // RFP cycle cleared so the deal can be re-submitted (and so a late bid-board-created callback,
    // which requires rfp_approval_status IS NOT NULL, can't resurrect it).
    expect(row.rfp_approval_status).toBeNull();
    expect(row.rfp_approval_requested_at).toBeNull();
    expect(row.rfp_approval_requested_by).toBeNull();
    expect(row.rfp_approval_token).toBeNull();

    // Identity PRESERVED — nulling it would make the SyncHub webhook miss and INSERT a twin deal.
    expect(row.procore_bid_id).toBe(887766);
    expect(row.procore_company_id).toBe("99000");
    expect(row.synchub_bid_board_id).toBe(`sh-${D.slice(-4)}`);
    expect(row.project_number).toBe("DFW-4-11826-ab");
    expect(row.bid_board_created_at).not.toBeNull();

    // "Take whatever relevant content is there": money columns survive the move.
    expect(String(row.awarded_amount)).toBe("250000.00");
    expect(String(row.bid_estimate)).toBe("240000.00");
  });

  it("records the move on the deal timeline and in the audit log", async () => {
    const D = U("d002");
    await seedBidBoardDeal(D);

    await returnDealToOpportunity(tdb, {
      dealId: D,
      userId: ADMIN,
      userRole: "admin",
      reason: "Scope incomplete",
      auditContext,
    });

    const { rows: history } = await pg.query<{ source: string; reason: string; changed_by: string; new_value: string }>(
      `SELECT source, reason, changed_by, new_value FROM public.deal_history WHERE deal_id = '${D}'`
    );
    expect(history).toHaveLength(1);
    expect(history[0].source).toBe("return_to_opportunity");
    expect(history[0].reason).toContain("Scope incomplete");
    expect(history[0].reason).toContain("disconnected from Bid Board");
    expect(history[0].changed_by).toBe(ADMIN);
    expect(history[0].new_value).toBe("Opportunity");

    const { rows: stageHistory } = await pg.query<{ to_stage_id: string; is_backward_move: boolean; override_reason: string }>(
      `SELECT to_stage_id, is_backward_move, override_reason FROM public.deal_stage_history WHERE deal_id = '${D}'`
    );
    expect(stageHistory).toHaveLength(1);
    expect(stageHistory[0].to_stage_id).toBe(OPP_STAGE);
    expect(stageHistory[0].is_backward_move).toBe(true);
    expect(stageHistory[0].override_reason).toBe("Scope incomplete");

    const { rows: audits } = await pg.query<{ changes: Record<string, unknown>; full_row: Record<string, unknown> }>(
      `SELECT changes, full_row FROM public.audit_log
        WHERE record_id = '${D}' AND table_name = 'deals'
          AND full_row ->> 'source' = 'return_to_opportunity'`
    );
    expect(audits).toHaveLength(1);
    expect(audits[0].full_row.reason).toBe("Scope incomplete");
    expect(audits[0].full_row.wasBidBoardLinked).toBe(true);
    expect(audits[0].changes).toHaveProperty("bidBoardDetachedAt");
  });
});

describe("returnDealToOpportunity — Won deals void commission", () => {
  it("deletes every commission row, clears the signed + Won dates, and audits the voided total", async () => {
    const D = U("d101");
    await seedBidBoardDeal(D, {
      stageId: WON_STAGE,
      contractSignedDate: "2026-03-01",
      wonClosedDate: "2026-03-01",
    });
    await seedCommission(D, REP, "18750.00", "owner");
    await seedCommission(D, DIRECTOR, "7500.00", "estimator");

    const result = await returnDealToOpportunity(tdb, {
      dealId: D,
      userId: ADMIN,
      userRole: "admin",
      reason: "Award was rescinded by the client.",
      acknowledgedCommissionTotal: "26250.00",
      acknowledgedCommissionRowCount: 2,
      auditContext,
    });

    expect(result.commissionRowsVoided).toBe(2);
    expect(result.commissionTotalVoided).toBe("26250.00");
    expect(result.contractSignedDateCleared).toBe("2026-03-01");

    const { rows: remaining } = await pg.query(
      `SELECT id FROM public.deal_signed_commissions WHERE deal_id = '${D}'`
    );
    expect(remaining).toHaveLength(0);

    const row = await dealRow(D);
    expect(row.stage_id).toBe(OPP_STAGE);
    expect(row.contract_signed_date).toBeNull();
    expect(row.contract_signed_at).toBeNull();
    // changeDealStage clears these; without them the deal would keep counting as Won revenue.
    expect(row.won_closed_date).toBeNull();
    expect(row.actual_close_date).toBeNull();

    // AUDIT TRAIL, itemized: one delete row per voided commission, naming amount + rep.
    const { rows: deleteAudits } = await pg.query<{ changes: Record<string, { from: unknown; to: unknown }>; changed_by: string }>(
      `SELECT changes, changed_by FROM public.audit_log
        WHERE table_name = 'deal_signed_commissions' AND action = 'delete'
          AND changes ->> 'dealId' IS NOT NULL
          AND changes -> 'dealId' ->> 'from' = '${D}'`
    );
    expect(deleteAudits).toHaveLength(2);
    expect(deleteAudits.every((a) => a.changed_by === ADMIN)).toBe(true);
    expect(deleteAudits.map((a) => String(a.changes.amount.from)).sort()).toEqual([
      "18750.00",
      "7500.00",
    ]);

    // AUDIT TRAIL, header: one deal row naming the total destroyed, so the answer to "how much did this
    // cost?" is one query, not a reconstruction from N delete rows.
    const { rows: dealAudits } = await pg.query<{ changes: Record<string, { from: unknown; to: unknown }>; full_row: Record<string, unknown> }>(
      `SELECT changes, full_row FROM public.audit_log
        WHERE record_id = '${D}' AND table_name = 'deals'
          AND full_row ->> 'source' = 'return_to_opportunity'`
    );
    expect(dealAudits).toHaveLength(1);
    expect(dealAudits[0].full_row.commissionRowsVoided).toBe(2);
    expect(dealAudits[0].full_row.commissionTotalVoided).toBe("26250.00");
    expect(dealAudits[0].changes.commissionVoidedTotal.from).toBe("26250.00");
    expect(dealAudits[0].changes.contractSignedDate.from).toBe("2026-03-01");

    const { rows: history } = await pg.query<{ reason: string }>(
      `SELECT reason FROM public.deal_history WHERE deal_id = '${D}'`
    );
    expect(history[0].reason).toContain("voided 2 commission row(s) totalling 26250.00");
  });

  it("refuses when the acknowledged total does not match the live sum, and destroys nothing", async () => {
    const D = U("d102");
    await seedBidBoardDeal(D, { stageId: WON_STAGE, contractSignedDate: "2026-03-01" });
    await seedCommission(D, REP, "18750.00");

    await expect(
      returnDealToOpportunity(tdb, {
        dealId: D,
        userId: ADMIN,
        userRole: "admin",
        reason: "stale dialog",
        // What the operator saw before a concurrent recompute moved the number.
        acknowledgedCommissionTotal: "9999.00",
        acknowledgedCommissionRowCount: 1,
        auditContext,
      })
    ).rejects.toMatchObject({ statusCode: 409, code: "MOVE_BACK_COMMISSION_ACK_REQUIRED" });

    const { rows } = await pg.query<{ amount: string }>(
      `SELECT amount FROM public.deal_signed_commissions WHERE deal_id = '${D}'`
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].amount).toBe("18750.00");
    expect((await dealRow(D)).stage_id).toBe(WON_STAGE);
    expect((await dealRow(D)).bid_board_detached_at).toBeNull();
  });

  // The acknowledgement is only worth anything if the rows it was computed from cannot move between
  // the check and the DELETE. The parent deal's FOR UPDATE does NOT give that: the settings-driven
  // recompute (recalculateCommissionForDeal, fanned out fire-and-forget after any rate edit) rewrites
  // deal_signed_commissions without ever locking or writing the deals row, and the sales-source mint
  // INSERTs a brand-new row the same way. These two cases cover both halves.
  it("takes the commission rows' row locks in the SAME transaction that validates the acknowledgement", async () => {
    const D = U("d104");
    await seedBidBoardDeal(D, { stageId: WON_STAGE, contractSignedDate: "2026-03-01" });
    await seedCommission(D, REP, "18750.00");

    const sql: string[] = [];
    const originalQuery = pg.query.bind(pg);
    const spy = vi.spyOn(pg, "query").mockImplementation((async (text: unknown, ...rest: unknown[]) => {
      if (typeof text === "string") sql.push(text);
      return originalQuery(text as never, ...(rest as never[]));
    }) as never);
    try {
      await returnDealToOpportunity(tdb, {
        dealId: D,
        userId: ADMIN,
        userRole: "admin",
        reason: "Award rescinded",
        acknowledgedCommissionTotal: "18750.00",
        acknowledgedCommissionRowCount: 1,
        auditContext,
      });
    } finally {
      spy.mockRestore();
    }

    const lockedRead = sql.findIndex(
      (text) => /deal_signed_commissions/i.test(text) && /for update/i.test(text)
    );
    expect(lockedRead, "the commit path must read the commission rows FOR UPDATE").toBeGreaterThan(-1);

    // The deal-scoped advisory lock closes the one writer row locks cannot: the settings recompute's
    // sales-source mint, which decides from an unlocked read and then INSERTs. Its ORDER is the
    // load-bearing part — it must come before EVERY row lock, because the recompute holds these locks
    // across a whole rep's deals. A waiter that already held row locks could close a dependency cycle
    // and deadlock; a waiter holding nothing simply queues.
    const advisoryLock = sql.findIndex((text) => /pg_advisory_xact_lock/i.test(text));
    expect(advisoryLock, "the commit path must take the deal commission advisory lock").toBeGreaterThan(-1);
    const firstRowLock = sql.findIndex((text) => /for update/i.test(text));
    expect(advisoryLock).toBeLessThan(firstRowLock);
  });

  it("aborts the ENTIRE move when a commission row appears after the acknowledgement, destroying nothing", async () => {
    const D = U("d105");
    await seedBidBoardDeal(D, { stageId: WON_STAGE, contractSignedDate: "2026-03-01" });
    await seedCommission(D, REP, "18750.00");

    // Stands in for the one writer row locks cannot stop: mintSalesSourceCommissionForDeal and
    // calculateCommissionForDeal INSERT a row for a rep that had none, without touching the deals row,
    // so a row that did not exist when the operator confirmed can appear mid-transaction. The trigger
    // fires on the detach UPDATE — after the acknowledgement was validated, before the DELETE — which
    // is exactly that window.
    await pg.exec(`
      CREATE OR REPLACE FUNCTION insert_late_commission() RETURNS trigger AS $fn$
      BEGIN
        INSERT INTO public.deal_signed_commissions
          (deal_id, rep_user_id, attribution_role, source_value_kind, source_value_amount,
           applied_rate, amount, contract_signed_date_at_signing, created_by)
        VALUES (NEW.id, '${DIRECTOR}', 'estimator', 'awarded_amount', 250000, 0.030000, 7500.00,
                '2026-03-01', '${ADMIN}');
        RETURN NEW;
      END;
      $fn$ LANGUAGE plpgsql;
      CREATE TRIGGER late_commission BEFORE UPDATE ON public.deals
        FOR EACH ROW
        WHEN (NEW.bid_board_detached_at IS NOT NULL AND OLD.bid_board_detached_at IS NULL)
        EXECUTE FUNCTION insert_late_commission();
    `);

    // BEGIN/ROLLBACK on the connection itself rather than tdb.transaction(), mirroring what the route
    // actually gets: middleware/tenant.ts issues BEGIN on the pooled client and binds Drizzle to that
    // same client, so the service's writes and the failure's rollback are the request transaction. (It
    // also avoids PGlite's transaction() mutex, which would deadlock the gate stub's own query.)
    await pg.exec("BEGIN");
    try {
      await expect(
        returnDealToOpportunity(tdb, {
          dealId: D,
          userId: ADMIN,
          userRole: "admin",
          reason: "Award rescinded",
          acknowledgedCommissionTotal: "18750.00",
          acknowledgedCommissionRowCount: 1,
          auditContext,
        })
      ).rejects.toMatchObject({ statusCode: 409, code: "MOVE_BACK_COMMISSION_CHANGED" });
    } finally {
      await pg.exec("ROLLBACK");
      await pg.exec(
        `DROP TRIGGER late_commission ON public.deals; DROP FUNCTION insert_late_commission();`
      );
    }

    // Nothing was destroyed and nothing was half-applied: the deal is still Won, still attached, and
    // the money the operator confirmed is still there. Without the count assertion the move would have
    // committed, deleting BOTH rows while reporting one row / $18,750.00 voided.
    const row = await dealRow(D);
    expect(row.stage_id).toBe(WON_STAGE);
    expect(row.bid_board_detached_at).toBeNull();
    expect(row.contract_signed_date).not.toBeNull();
    const { rows } = await pg.query<{ amount: string }>(
      `SELECT amount FROM public.deal_signed_commissions WHERE deal_id = '${D}'`
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].amount).toBe("18750.00");
  });

  it("refuses when the total matches but the ROW COUNT does not — a total alone does not pin the set", async () => {
    const D = U("d106");
    await seedBidBoardDeal(D, { stageId: WON_STAGE, contractSignedDate: "2026-03-01" });
    // The live book is 2 rows; the operator's dialog said 1. The money is identical either way, so the
    // total check passes — but the SET the operator agreed to destroy is not the set on the deal.
    await seedCommission(D, REP, "9375.00", "owner");
    await seedCommission(D, DIRECTOR, "9375.00", "estimator");

    await expect(
      returnDealToOpportunity(tdb, {
        dealId: D,
        userId: ADMIN,
        userRole: "admin",
        reason: "stale row count",
        acknowledgedCommissionTotal: "18750.00",
        acknowledgedCommissionRowCount: 1,
        auditContext,
      })
    ).rejects.toMatchObject({ statusCode: 409, code: "MOVE_BACK_COMMISSION_ACK_REQUIRED" });

    const { rows } = await pg.query(`SELECT id FROM public.deal_signed_commissions WHERE deal_id = '${D}'`);
    expect(rows).toHaveLength(2);
    expect((await dealRow(D)).bid_board_detached_at).toBeNull();
  });

  it("refuses when the row count is omitted entirely", async () => {
    const D = U("d107");
    await seedBidBoardDeal(D, { stageId: WON_STAGE, contractSignedDate: "2026-03-01" });
    await seedCommission(D, REP, "18750.00");

    await expect(
      returnDealToOpportunity(tdb, {
        dealId: D,
        userId: ADMIN,
        userRole: "admin",
        reason: "total only",
        acknowledgedCommissionTotal: "18750.00",
        auditContext,
      })
    ).rejects.toMatchObject({ statusCode: 409, code: "MOVE_BACK_COMMISSION_ACK_REQUIRED" });

    const { rows } = await pg.query(`SELECT id FROM public.deal_signed_commissions WHERE deal_id = '${D}'`);
    expect(rows).toHaveLength(1);
  });

  it("refuses when no acknowledgement is supplied at all", async () => {
    const D = U("d103");
    await seedBidBoardDeal(D, { stageId: WON_STAGE, contractSignedDate: "2026-03-01" });
    await seedCommission(D, REP, "100.00");

    await expect(
      returnDealToOpportunity(tdb, {
        dealId: D,
        userId: ADMIN,
        userRole: "admin",
        reason: "no ack",
        auditContext,
      })
    ).rejects.toMatchObject({ code: "MOVE_BACK_COMMISSION_ACK_REQUIRED" });

    const { rows } = await pg.query(`SELECT id FROM public.deal_signed_commissions WHERE deal_id = '${D}'`);
    expect(rows).toHaveLength(1);
  });
});

describe("returnDealToOpportunity — permissions and state blocks", () => {
  it("403s a DIRECTOR on a deal with booked commission, leaving the money intact", async () => {
    const D = U("d201");
    await seedBidBoardDeal(D, { stageId: WON_STAGE, contractSignedDate: "2026-03-01" });
    await seedCommission(D, REP, "18750.00");

    await expect(
      returnDealToOpportunity(tdb, {
        dealId: D,
        userId: DIRECTOR,
        userRole: "director",
        reason: "director attempt",
        acknowledgedCommissionTotal: "18750.00",
        acknowledgedCommissionRowCount: 1,
        auditContext,
      })
    ).rejects.toMatchObject({ statusCode: 403, code: "MOVE_BACK_COMMISSION_ROLE_NOT_ALLOWED" });

    const { rows } = await pg.query(`SELECT id FROM public.deal_signed_commissions WHERE deal_id = '${D}'`);
    expect(rows).toHaveLength(1);
    expect((await dealRow(D)).stage_id).toBe(WON_STAGE);
  });

  it("403s a REP on an ordinary estimating deal (a backward move reps cannot make)", async () => {
    const D = U("d202");
    await seedBidBoardDeal(D);

    await expect(
      returnDealToOpportunity(tdb, {
        dealId: D,
        userId: REP,
        userRole: "rep",
        reason: "rep attempt",
        auditContext,
      })
    ).rejects.toMatchObject({ statusCode: 403, code: "MOVE_BACK_ROLE_NOT_ALLOWED" });

    expect((await dealRow(D)).bid_board_detached_at).toBeNull();
  });

  it("lets a DIRECTOR move an ordinary estimating deal back", async () => {
    const D = U("d203");
    await seedBidBoardDeal(D);

    await returnDealToOpportunity(tdb, {
      dealId: D,
      userId: DIRECTOR,
      userRole: "director",
      reason: "Needs re-scoping",
      auditContext,
    });

    const row = await dealRow(D);
    expect(row.stage_id).toBe(OPP_STAGE);
    expect(row.bid_board_detached_by).toBe(DIRECTOR);
  });

  it("409s a parent that still has ACTIVE change-order children", async () => {
    const D = U("d204");
    const CO = U("d205");
    await seedBidBoardDeal(D, { stageId: WON_STAGE, contractSignedDate: "2026-03-01" });
    await seedBidBoardDeal(CO, { stageId: WON_STAGE, isChangeOrder: true, parentDealId: D });

    await expect(
      returnDealToOpportunity(tdb, {
        dealId: D,
        userId: ADMIN,
        userRole: "admin",
        reason: "has change orders",
        auditContext,
      })
    ).rejects.toMatchObject({ statusCode: 409, code: "MOVE_BACK_HAS_CHANGE_ORDERS" });

    expect((await dealRow(D)).bid_board_detached_at).toBeNull();
  });

  it("409s a CLEAN Opportunity deal, so a live RFP cycle is never cleared by accident", async () => {
    const D = U("d206");
    await seedBidBoardDeal(D, { stageId: OPP_STAGE });
    // Clean = nothing linked to sever and no money to void. This is the case the block exists for: such
    // a deal may have an RFP submission in flight (requested, not yet linked), and running the reset
    // would silently cancel it.
    await pg.exec(
      `UPDATE public.deals SET is_bid_board_owned = false, bid_board_linked_at = NULL,
         bid_board_project_number = NULL, read_only_synced_at = NULL, is_read_only_mirror = false,
         procore_bid_id = NULL, synchub_bid_board_id = NULL, bid_board_created_at = NULL,
         contract_signed_date = NULL, contract_signed_at = NULL
       WHERE id = '${D}'`
    );

    await expect(
      returnDealToOpportunity(tdb, {
        dealId: D,
        userId: ADMIN,
        userRole: "admin",
        reason: "already there",
        auditContext,
      })
    ).rejects.toMatchObject({ statusCode: 409, code: "MOVE_BACK_ALREADY_OPPORTUNITY" });

    expect((await dealRow(D)).rfp_approval_status).toBe("approved");
  });

  // The Bid Board is authoritative over stage and APPLIES backward moves, so a mirror can park a deal
  // that it still OWNS on Opportunity. Blocking on the stage alone left an admin unable to sever a sync
  // that kept reclaiming the deal on every export.
  it("ALLOWS a still-LINKED Opportunity deal to be detached — the sync keeps reclaiming it otherwise", async () => {
    const D = U("d210");
    await seedBidBoardDeal(D, { stageId: OPP_STAGE });

    const preview = await previewReturnToOpportunity(tdb, { dealId: D, userRole: "admin" });
    expect(preview.allowed).toBe(true);
    expect(preview.blockCode).toBeNull();

    await returnDealToOpportunity(tdb, {
      dealId: D,
      userId: ADMIN,
      userRole: "admin",
      reason: "Mirror parked it here while still owning it",
      auditContext,
    });

    const row = await dealRow(D);
    expect(row.bid_board_detached_at).not.toBeNull();
    expect(row.is_bid_board_owned).toBe(false);
    expect(row.bid_board_project_number).toBeNull();
    expect(row.rfp_approval_status).toBeNull();
  });

  // The same stage can also retain MONEY: a Won deal walked backward by the mirror keeps its signed date
  // and commission rows, and only this action can void them.
  it("ALLOWS an Opportunity deal that still carries booked commission", async () => {
    const D = U("d211");
    await seedBidBoardDeal(D, { stageId: OPP_STAGE, contractSignedDate: "2026-03-01" });
    await seedCommission(D, REP, "18750.00");
    // Strip every Bid Board signal so ONLY the retained money can unblock it.
    await pg.exec(
      `UPDATE public.deals SET is_bid_board_owned = false, bid_board_linked_at = NULL,
         bid_board_project_number = NULL, read_only_synced_at = NULL, is_read_only_mirror = false,
         procore_bid_id = NULL, synchub_bid_board_id = NULL, bid_board_created_at = NULL
       WHERE id = '${D}'`
    );

    const preview = await previewReturnToOpportunity(tdb, { dealId: D, userRole: "admin" });
    expect(preview.allowed).toBe(true);
    expect(preview.voidsCommission).toBe(true);

    const result = await returnDealToOpportunity(tdb, {
      dealId: D,
      userId: ADMIN,
      userRole: "admin",
      reason: "Void the commission the mirror left behind",
      acknowledgedCommissionTotal: "18750.00",
      acknowledgedCommissionRowCount: 1,
      auditContext,
    });
    expect(result.commissionRowsVoided).toBe(1);

    const { rows } = await pg.query(`SELECT id FROM public.deal_signed_commissions WHERE deal_id = '${D}'`);
    expect(rows).toHaveLength(0);
  });

  it("409s a parent carrying a LEGACY deal_change_orders row, not just child-deal COs", async () => {
    const D = U("d209");
    await seedBidBoardDeal(D, { stageId: WON_STAGE, contractSignedDate: "2026-03-01" });
    // The un-migrated representation: value-only, no backing deal. listDealChangeOrders and
    // getDealChangeOrdersTotal both UNION it with child deals, so it still contributes to the deal's
    // contract value — counting only children would move the parent to Opportunity underneath it.
    await pg.exec(
      `INSERT INTO public.deal_change_orders (deal_id, signed_date, amount, description, created_by)
       VALUES ('${D}', '2026-04-01', 25000.00, 'Legacy CO', '${ADMIN}')`
    );

    await expect(
      returnDealToOpportunity(tdb, {
        dealId: D,
        userId: ADMIN,
        userRole: "admin",
        reason: "legacy change order",
        auditContext,
      })
    ).rejects.toMatchObject({ statusCode: 409, code: "MOVE_BACK_HAS_CHANGE_ORDERS" });

    expect((await dealRow(D)).bid_board_detached_at).toBeNull();
    expect((await dealRow(D)).stage_id).toBe(WON_STAGE);
  });

  it("409s an ARCHIVED deal — restore it first, rather than reviving it through a stage move", async () => {
    const D = U("d208");
    await seedBidBoardDeal(D, { isActive: false });

    await expect(
      returnDealToOpportunity(tdb, {
        dealId: D,
        userId: ADMIN,
        userRole: "admin",
        reason: "archived attempt",
        auditContext,
      })
    ).rejects.toMatchObject({ statusCode: 409, code: "MOVE_BACK_DEAL_INACTIVE" });

    const row = await dealRow(D);
    expect(row.bid_board_detached_at).toBeNull();
    expect(row.stage_id).toBe(ESTIMATING_STAGE);
  });

  it("400s an empty reason", async () => {
    const D = U("d207");
    await seedBidBoardDeal(D);

    await expect(
      returnDealToOpportunity(tdb, {
        dealId: D,
        userId: ADMIN,
        userRole: "admin",
        reason: "   ",
        auditContext,
      })
    ).rejects.toMatchObject({ statusCode: 400, code: "MOVE_BACK_REASON_REQUIRED" });
  });
});

// Clearing the RFP columns is not enough on its own. handleRfpRequestDelivery POSTs its payload without
// re-reading the deal and writes rfp_approval_status back BY DEAL ID, so a queued delivery repopulates
// the cycle we just cleared — and a non-null status is exactly what re-arms the bid-board-created
// resurrection guard. cancelPendingRfp (whose field list this action copies) sidesteps the same race by
// REFUSING in-flight requests; this action cannot refuse, so it cancels the work instead.
// A REPEAT move-back (detach -> advance the stage by hand -> move back again) is reachable because the
// round-5 narrowing of isReturnToOpportunityNoOp deliberately re-allows the action on an already-detached
// deal that has since gained money. isDealBidBoardLinked() answers false whenever the marker is set —
// purely because it is set — so a naive recompute would downgrade the persisted answer.
describe("returnDealToOpportunity — a repeat detach preserves what the first one recorded", () => {
  it("keeps bid_board_detached_was_linked true, so the standing reminder survives", async () => {
    const D = U("d701");
    await seedBidBoardDeal(D);

    await returnDealToOpportunity(tdb, {
      dealId: D, userId: ADMIN, userRole: "admin", reason: "First detach", auditContext,
    });
    expect((await dealRow(D)).bid_board_detached_was_linked).toBe(true);

    // Walk it forward by hand (stays detached — the handoff block is skipped), then move it back again.
    await pg.exec(`UPDATE public.deals SET stage_id = '${ESTIMATING_STAGE}' WHERE id = '${D}'`);
    await returnDealToOpportunity(tdb, {
      dealId: D, userId: ADMIN, userRole: "admin", reason: "Second detach", auditContext,
    });

    const row = await dealRow(D);
    // The flag describes the RETIRED PROJECT, not the deal's live state, so it must not be recomputed.
    expect(row.bid_board_detached_was_linked).toBe(true);
    expect(row.bid_board_detach_reason).toBe("Second detach");
  });

  it("records the PRIOR detach timestamp in the audit instead of asserting null", async () => {
    const D = U("d702");
    await seedBidBoardDeal(D);
    await returnDealToOpportunity(tdb, {
      dealId: D, userId: ADMIN, userRole: "admin", reason: "First detach", auditContext,
    });
    const firstDetachedAt = (await dealRow(D)).bid_board_detached_at;

    await pg.exec(`UPDATE public.deals SET stage_id = '${ESTIMATING_STAGE}' WHERE id = '${D}'`);
    await returnDealToOpportunity(tdb, {
      dealId: D, userId: ADMIN, userRole: "admin", reason: "Second detach", auditContext,
    });

    const { rows: audits } = await pg.query<{ changes: Record<string, { from: unknown; to: unknown }> }>(
      `SELECT changes FROM public.audit_log
        WHERE record_id = '${D}' AND table_name = 'deals'
          AND full_row ->> 'source' = 'return_to_opportunity'
        ORDER BY created_at`
    );
    expect(audits).toHaveLength(2);
    // A hardcoded null claimed "this deal had never been detached" on every repeat — false, and
    // inconsistent with the adjacent isBidBoardOwned field which reads live state.
    expect(audits[0].changes.bidBoardDetachedAt.from).toBeNull();
    expect(audits[1].changes.bidBoardDetachedAt.from).not.toBeNull();
    // Within a second of the first detach (the stored timestamptz round-trips at lower precision than
    // the ISO string the audit records) — the point is that it is the REAL prior value, not null.
    const recordedFrom = new Date(String(audits[1].changes.bidBoardDetachedAt.from)).getTime();
    expect(Math.abs(recordedFrom - new Date(String(firstDetachedAt)).getTime())).toBeLessThan(1000);
  });
});

describe("returnDealToOpportunity — queued RFP work is cancelled with the cycle", () => {
  async function queueRfpJob(dealId: string, jobType: string, status = "pending") {
    await pg.exec(
      `INSERT INTO public.job_queue (job_type, payload, status, run_after)
       VALUES ('${jobType}', '{"dealId":"${dealId}"}'::jsonb, '${status}', now())`
    );
  }
  async function jobRows(dealId: string) {
    const { rows } = await pg.query<{ job_type: string; status: string; payload: Record<string, unknown> }>(
      `SELECT job_type, status, payload FROM public.job_queue
        WHERE payload->>'dealId' = '${dealId}'
          AND job_type IN ('rfp_request_delivery', 'rfp_bidboard_create')
        ORDER BY job_type`
    );
    return rows;
  }

  it("cancels the queued delivery and bid-board-create jobs so neither can resurrect the cycle", async () => {
    const D = U("d601");
    await seedBidBoardDeal(D);
    await pg.exec(`UPDATE public.deals SET rfp_approval_status = 'pending_outbox' WHERE id = '${D}'`);
    await queueRfpJob(D, "rfp_request_delivery");
    await queueRfpJob(D, "rfp_bidboard_create");

    await returnDealToOpportunity(tdb, {
      dealId: D,
      userId: ADMIN,
      userRole: "admin",
      reason: "Cancel the in-flight submission",
      auditContext,
    });

    const jobs = await jobRows(D);
    expect(jobs).toHaveLength(2);
    for (const job of jobs) {
      // 'completed', never 'dead': the dead-letter sweep claims dead rfp_request_delivery rows and
      // stamps the deal send_failed — repopulating the very field this action clears.
      expect(job.status).toBe("completed");
      expect(job.payload.cancelledBy).toBe("return_to_opportunity");
    }
    expect((await dealRow(D)).rfp_approval_status).toBeNull();
  });

  it("leaves another deal's queued jobs and this deal's already-claimed job alone", async () => {
    const D = U("d602");
    const OTHER = U("d603");
    await seedBidBoardDeal(D);
    await seedBidBoardDeal(OTHER);
    await queueRfpJob(OTHER, "rfp_request_delivery");
    // Already claimed by a worker — beyond this transaction's reach, which is why the worker carries
    // the other half of the guard.
    await queueRfpJob(D, "rfp_request_delivery", "processing");

    await returnDealToOpportunity(tdb, {
      dealId: D,
      userId: ADMIN,
      userRole: "admin",
      reason: "Only cancel what is still queued",
      auditContext,
    });

    expect((await jobRows(OTHER))[0].status).toBe("pending");
    expect((await jobRows(D))[0].status).toBe("processing");
  });
});

describe("returnDealToOpportunity — the deal can actually be used again afterwards", () => {
  it("satisfies every condition of the trigger-RFP atomic reservation", async () => {
    const D = U("d401");
    await seedBidBoardDeal(D);

    await returnDealToOpportunity(tdb, {
      dealId: D,
      userId: ADMIN,
      userRole: "admin",
      reason: "Re-scope then resubmit",
      auditContext,
    });

    // Replays POST /deals/:id/trigger-rfp's reservation predicate VERBATIM. Missing any ONE of these
    // ten conditions makes the deal a dead end: the move-back appears to work, and then the rep gets an
    // unexplained 409 when they try to re-submit it — discoverable only in production.
    const { rows } = await pg.query<{ ok: boolean }>(
      `SELECT (
          id = '${D}'
          AND rfp_approval_status IS NULL
          AND rfp_approval_requested_at IS NULL
          AND is_bid_board_owned = false
          AND (bid_board_stage_slug IS NULL OR bid_board_stage_slug = '')
          AND is_read_only_mirror = false
          AND read_only_synced_at IS NULL
          AND bid_board_stage_entered_at IS NULL
          AND bid_board_mirror_source_entered_at IS NULL
        ) AS ok
       FROM public.deals WHERE id = '${D}'`
    );
    expect(rows[0].ok).toBe(true);
  });

  it("clears every scope-lock input so the operator can fix the scope that blocked the deal", async () => {
    const D = U("d402");
    await seedBidBoardDeal(D);

    await returnDealToOpportunity(tdb, {
      dealId: D,
      userId: ADMIN,
      userRole: "admin",
      reason: "Scope was wrong",
      auditContext,
    });

    // resolveDealScopeLockState locks on: rfp submission (requestedAt OR status) OR bid-board handoff
    // (bidBoardLinkedAt OR bidBoardProjectNumber OR inferred ownership) OR past-Opportunity. The plain
    // backward stage move clears NONE of the first four, which is why it strands the deal read-only.
    const row = await dealRow(D);
    expect(row.rfp_approval_requested_at).toBeNull();
    expect(row.rfp_approval_status).toBeNull();
    expect(row.bid_board_linked_at).toBeNull();
    expect(row.bid_board_project_number).toBeNull();
    expect(row.stage_id).toBe(OPP_STAGE); // not past Opportunity any more
  });
});

describe("re-attaching a detached deal", () => {
  it("a forward move into estimating does NOT re-attach — no Bid Board project exists yet", async () => {
    const D = U("d501");
    await seedBidBoardDeal(D);

    await returnDealToOpportunity(tdb, {
      dealId: D,
      userId: ADMIN,
      userRole: "admin",
      reason: "Not ready",
      auditContext,
    });
    expect((await dealRow(D)).bid_board_detached_at).not.toBeNull();

    // Walk it forward to estimating by hand. THE INVARIANT: a deal re-attaches only when a Bid Board
    // project demonstrably exists for it, and changeDealStage neither creates nor links one — so this
    // path must leave the detach alone. Re-attaching here used to produce two real failures: an
    // operator who had followed the dialog and deleted the old project got a Bid-Board-owned, read-only
    // deal with no counterpart; one who had not got the old project reclaimed on the next export,
    // silently undoing the move-back.
    vi.mocked(validateStageGate).mockImplementation(async () => ({
      allowed: true,
      isBackwardMove: false,
      isTerminal: false,
      targetStage: STAGES[ESTIMATING_STAGE],
      currentStage: STAGES[OPP_STAGE],
      missingRequirements: {
        fields: [], documents: [], approvals: [],
        effectiveChecklist: { fields: [], attachments: [], approvals: [] },
      },
      effectiveChecklist: { fields: [], attachments: [], approvals: [] },
      requiresOverride: false,
      overrideType: null,
      blockReason: null,
    }) as never);

    await changeDealStage(tdb, {
      dealId: D,
      targetStageId: ESTIMATING_STAGE,
      userId: ADMIN,
      userRole: "admin",
      auditContext,
    });

    const row = await dealRow(D);
    // The stage advances...
    expect(row.stage_id).toBe(ESTIMATING_STAGE);
    // ...but the deal stays detached and CRM-owned.
    expect(row.bid_board_detached_at).not.toBeNull();
    expect(row.bid_board_detach_reason).toBe("Not ready");
    expect(row.is_bid_board_owned).toBe(false);

    // The whole handoff block is skipped, not just the marker clear: is_bid_board_owned,
    // bid_board_stage_slug and read_only_synced_at are three of the ten conditions the trigger-RFP
    // atomic reservation requires to be EMPTY. Setting them here would leave the deal unable to be
    // re-submitted — the "re-trigger silently impossible" dead end this feature exists to remove — so
    // the deal must still satisfy the reservation after being walked forward.
    expect(row.bid_board_stage_slug).toBeNull();
    expect(row.read_only_synced_at).toBeNull();
    const { rows: reservable } = await pg.query<{ ok: boolean }>(
      `SELECT (
          rfp_approval_status IS NULL
          AND is_bid_board_owned = false
          AND (bid_board_stage_slug IS NULL OR bid_board_stage_slug = '')
          AND is_read_only_mirror = false
          AND read_only_synced_at IS NULL
          AND bid_board_stage_entered_at IS NULL
          AND bid_board_mirror_source_entered_at IS NULL
        ) AS ok
       FROM public.deals WHERE id = '${D}'`
    );
    expect(reservable[0].ok, "a forward-moved detached deal must still be re-submittable").toBe(true);
  });

  it("still hands an ATTACHED deal to Bid Board on the same forward move", async () => {
    // The skip is scoped to detached deals; the ordinary handoff is untouched.
    const D = U("d503");
    await seedBidBoardDeal(D, { stageId: OPP_STAGE });
    await pg.exec(
      `UPDATE public.deals SET is_bid_board_owned = false, bid_board_stage_slug = NULL,
         read_only_synced_at = NULL, bid_board_detached_at = NULL WHERE id = '${D}'`
    );

    vi.mocked(validateStageGate).mockImplementation(async () => ({
      allowed: true,
      isBackwardMove: false,
      isTerminal: false,
      targetStage: STAGES[ESTIMATING_STAGE],
      currentStage: STAGES[OPP_STAGE],
      missingRequirements: {
        fields: [], documents: [], approvals: [],
        effectiveChecklist: { fields: [], attachments: [], approvals: [] },
      },
      effectiveChecklist: { fields: [], attachments: [], approvals: [] },
      requiresOverride: false,
      overrideType: null,
      blockReason: null,
    }) as never);

    await changeDealStage(tdb, {
      dealId: D,
      targetStageId: ESTIMATING_STAGE,
      userId: ADMIN,
      userRole: "admin",
      auditContext,
    });

    const row = await dealRow(D);
    expect(row.is_bid_board_owned).toBe(true);
    expect(row.bid_board_stage_slug).toBe("estimating");
    expect(row.read_only_synced_at).not.toBeNull();
  });

  it("never logs a detach reversal from a stage move — the callback owns re-attachment", async () => {
    const D = U("d502");
    await seedBidBoardDeal(D, { stageId: OPP_STAGE });

    vi.mocked(validateStageGate).mockImplementation(async () => ({
      allowed: true,
      isBackwardMove: false,
      isTerminal: false,
      targetStage: STAGES[ESTIMATING_STAGE],
      currentStage: STAGES[OPP_STAGE],
      missingRequirements: {
        fields: [], documents: [], approvals: [],
        effectiveChecklist: { fields: [], attachments: [], approvals: [] },
      },
      effectiveChecklist: { fields: [], attachments: [], approvals: [] },
      requiresOverride: false,
      overrideType: null,
      blockReason: null,
    }) as never);

    await changeDealStage(tdb, {
      dealId: D,
      targetStageId: ESTIMATING_STAGE,
      userId: ADMIN,
      userRole: "admin",
      auditContext,
    });

    const { rows } = await pg.query(
      `SELECT id FROM public.audit_log
        WHERE record_id = '${D}' AND table_name = 'deals' AND changes ? 'bidBoardDetachedAt'`
    );
    expect(rows).toHaveLength(0);
  });
});

describe("previewReturnToOpportunity", () => {
  it("names the exact commission total and the Bid Board deep-link inputs the dialog needs", async () => {
    const D = U("d301");
    await seedBidBoardDeal(D, { stageId: WON_STAGE, contractSignedDate: "2026-03-01" });
    await seedCommission(D, REP, "18750.00");
    await seedCommission(D, DIRECTOR, "7500.00", "estimator");

    const preview = await previewReturnToOpportunity(tdb, { dealId: D, userRole: "admin" });

    expect(preview.allowed).toBe(true);
    expect(preview.voidsCommission).toBe(true);
    expect(preview.commissionRowCount).toBe(2);
    expect(preview.commissionTotal).toBe("26250.00");
    expect(preview.isWonFamily).toBe(true);
    expect(preview.isBidBoardLinked).toBe(true);
    expect(preview.procoreCompanyId).toBe("99000");
    expect(preview.procoreBidId).toBe("887766");
    expect(preview.effectiveContractSignedDate).toBe("2026-03-01");
  });

  // The preview's "you must delete this project from Bid Board yourself" block and the commit path's
  // wasBidBoardLinked audit flag are ONE predicate. They drifted once (the preview counted
  // procore_bid_id, the audit flag did not), which told the operator to go delete a project while
  // recording that nothing had been disconnected.
  it("agrees with the commit path on a legacy deal whose only footprint is the preserved Procore id", async () => {
    const D = U("d303");
    await seedBidBoardDeal(D);
    // A legacy import: the CRM never owned it through Bid Board sync, but it carries the Procore
    // identity — which the detach deliberately PRESERVES, and which is how the operator finds the
    // project to delete.
    await pg.exec(
      `UPDATE public.deals SET is_bid_board_owned = false, bid_board_linked_at = NULL,
         bid_board_project_number = NULL, read_only_synced_at = NULL, is_read_only_mirror = false,
         synchub_bid_board_id = NULL
       WHERE id = '${D}'`
    );

    const preview = await previewReturnToOpportunity(tdb, { dealId: D, userRole: "admin" });
    expect(preview.isBidBoardLinked).toBe(true);

    const result = await returnDealToOpportunity(tdb, {
      dealId: D,
      userId: ADMIN,
      userRole: "admin",
      reason: "Legacy import, not ready",
      auditContext,
    });
    expect(result.wasBidBoardLinked).toBe(preview.isBidBoardLinked);

    const { rows: audits } = await pg.query<{ full_row: Record<string, unknown> }>(
      `SELECT full_row FROM public.audit_log
        WHERE record_id = '${D}' AND table_name = 'deals'
          AND full_row ->> 'source' = 'return_to_opportunity'`
    );
    expect(audits[0].full_row.wasBidBoardLinked).toBe(true);

    const { rows: history } = await pg.query<{ reason: string }>(
      `SELECT reason FROM public.deal_history WHERE deal_id = '${D}'`
    );
    expect(history[0].reason).toContain("disconnected from Bid Board");
  });

  it("says a deal with NO Bid Board footprint at all was never linked, in the dialog and the audit", async () => {
    const D = U("d304");
    await seedBidBoardDeal(D, { contractSignedDate: "2026-03-01" });
    // Carries commission, so the move takes the commission-voiding branch of the history text — the
    // branch that used to hardcode "(disconnected from Bid Board; …)" regardless of linkage.
    await seedCommission(D, REP, "18750.00");
    await pg.exec(
      `UPDATE public.deals SET is_bid_board_owned = false, bid_board_linked_at = NULL,
         bid_board_project_number = NULL, read_only_synced_at = NULL, is_read_only_mirror = false,
         synchub_bid_board_id = NULL, procore_bid_id = NULL, procore_company_id = NULL
       WHERE id = '${D}'`
    );

    const preview = await previewReturnToOpportunity(tdb, { dealId: D, userRole: "admin" });
    expect(preview.isBidBoardLinked).toBe(false);

    const result = await returnDealToOpportunity(tdb, {
      dealId: D,
      userId: ADMIN,
      userRole: "admin",
      reason: "CRM-only deal",
      acknowledgedCommissionTotal: "18750.00",
      acknowledgedCommissionRowCount: 1,
      auditContext,
    });
    expect(result.wasBidBoardLinked).toBe(false);
    expect(result.commissionRowsVoided).toBe(1);

    // The timeline must not claim a disconnection that did not happen — including on the
    // commission-voiding branch, where the phrase used to be hardcoded.
    const { rows: history } = await pg.query<{ reason: string }>(
      `SELECT reason FROM public.deal_history WHERE deal_id = '${D}'`
    );
    expect(history[0].reason).not.toContain("disconnected from Bid Board");
    expect(history[0].reason).toContain("voided 1 commission row(s) totalling 18750.00");
  });

  it("reports the block reason for a director rather than pretending the action is available", async () => {
    const D = U("d302");
    await seedBidBoardDeal(D, { stageId: WON_STAGE, contractSignedDate: "2026-03-01" });
    await seedCommission(D, REP, "18750.00");

    const preview = await previewReturnToOpportunity(tdb, { dealId: D, userRole: "director" });
    expect(preview.allowed).toBe(false);
    expect(preview.blockCode).toBe("COMMISSION_ROLE_NOT_ALLOWED");
    expect(preview.commissionTotal).toBe("18750.00");
  });
});

// The standing banner cannot key on bid_board_detached_at alone — the action stamps it on any deal it
// moves back — and the client cannot derive the answer either, because the detach nulls
// bid_board_linked_at and bid_board_project_number. It is derived server-side from what the detach
// deliberately PRESERVES.
describe("buildBidBoardOwnershipState — was there a project behind the detach?", () => {
  it("reports detachedFromLinkedProject from the PERSISTED answer, with no identity columns at all", () => {
    // The majority shape in prod: 315 of Dallas's 1,294 active deals are Bid Board linked while
    // carrying neither a procore nor a SyncHub id. Deriving the answer after the fact would drop the
    // reminder on every one of them, which is why the detach records it.
    const state = buildBidBoardOwnershipState({
      isBidBoardOwned: false,
      workflowRoute: "normal",
      bidBoardDetachedAt: new Date("2026-07-20T12:00:00Z"),
      bidBoardDetachedWasLinked: true,
      procoreBidId: null,
      synchubBidBoardId: null,
    });
    expect(state.detachedFromLinkedProject).toBe(true);
    expect(state.message).toContain("Delete the project from the Bid Board");
  });

  it("does NOT claim a project for a CRM-only deal that was moved back", () => {
    const state = buildBidBoardOwnershipState({
      isBidBoardOwned: false,
      workflowRoute: "normal",
      bidBoardDetachedAt: new Date("2026-07-20T12:00:00Z"),
      bidBoardDetachedWasLinked: false,
      procoreBidId: null,
      synchubBidBoardId: null,
    });
    expect(state.detachedFromLinkedProject).toBe(false);
    expect(state.message).not.toContain("Delete the project from the Bid Board");
  });

  it("falls back to the preserved identity only when the persisted answer is absent", () => {
    // A row detached before the column existed. None in practice (the column ships with the feature),
    // and the fallback errs toward SHOWING the reminder rather than hiding a real project.
    const state = buildBidBoardOwnershipState({
      isBidBoardOwned: false,
      workflowRoute: "normal",
      bidBoardDetachedAt: new Date("2026-07-20T12:00:00Z"),
      bidBoardDetachedWasLinked: null,
      procoreBidId: 887766,
      synchubBidBoardId: null,
    });
    expect(state.detachedFromLinkedProject).toBe(true);
  });

  // The menu guard consumes THIS flag rather than re-deriving linkage client-side. The first client
  // copy drifted immediately — it omitted synchub_bid_board_id and read_only_synced_at, so a
  // SyncHub-created deal walked backward into a stable-id-only state had the action hidden even though
  // the next webhook could still reclaim it.
  it.each([
    ["synchubBidBoardId only", { synchubBidBoardId: "bb-1" }],
    ["readOnlySyncedAt only", { readOnlySyncedAt: new Date("2026-05-01T00:00:00Z") }],
    ["bidBoardProjectNumber only", { bidBoardProjectNumber: "DFW-4-11826-ab" }],
    ["procoreBidId only", { procoreBidId: 887766 }],
  ])("publishes isBidBoardLinked for a deal whose only footprint is %s", (_label, footprint) => {
    const state = buildBidBoardOwnershipState({
      isBidBoardOwned: false,
      workflowRoute: "normal",
      bidBoardDetachedAt: null,
      ...footprint,
    });
    expect(state.isBidBoardLinked).toBe(true);
  });

  it("reports a detached deal as NOT linked, whatever identity it kept", () => {
    const state = buildBidBoardOwnershipState({
      isBidBoardOwned: false,
      workflowRoute: "normal",
      bidBoardDetachedAt: new Date("2026-07-20T12:00:00Z"),
      bidBoardDetachedWasLinked: true,
      procoreBidId: 887766,
      synchubBidBoardId: "bb-1",
    });
    expect(state.isBidBoardLinked).toBe(false);
  });

  it("reports a CRM-only deal as not linked", () => {
    const state = buildBidBoardOwnershipState({
      isBidBoardOwned: false,
      workflowRoute: "normal",
      bidBoardDetachedAt: null,
    });
    expect(state.isBidBoardLinked).toBe(false);
  });

  it("is false on a deal that was never detached, whatever identity it carries", () => {
    const state = buildBidBoardOwnershipState({
      isBidBoardOwned: true,
      workflowRoute: "normal",
      bidBoardDetachedAt: null,
      procoreBidId: 887766,
      synchubBidBoardId: "sh-1",
    });
    expect(state.detachedFromLinkedProject).toBe(false);
    expect(state.isOwned).toBe(true);
  });
});

describe("migration 0200 — tenant column-add shape", () => {
  const migration = readFileSync(
    resolve(import.meta.dirname, "../../../../migrations/0200_deals_bid_board_detached.sql"),
    "utf8"
  );

  it("adds the detach columns to every existing office schema in the DO-loop", () => {
    expect(migration).toContain("LIKE 'office\\_%'");
    expect(migration).toContain("to_regclass(format('%I.deals', schema_name))");
    expect(migration).toContain("ADD COLUMN IF NOT EXISTS bid_board_detached_at timestamptz");
    expect(migration).toContain("ADD COLUMN IF NOT EXISTS bid_board_detached_by uuid");
    expect(migration).toContain("ADD COLUMN IF NOT EXISTS bid_board_detach_reason text");
    expect(migration).toContain("ADD COLUMN IF NOT EXISTS bid_board_detached_was_linked boolean");
    expect(migration).toContain("ADD COLUMN IF NOT EXISTS skipped_detached_count INTEGER NOT NULL DEFAULT 0");
  });

  it("has a matching TENANT_SCHEMA block — the provisioner replays ONLY this, so omitting it drifts new offices", () => {
    const start = migration.indexOf("-- TENANT_SCHEMA_START");
    const end = migration.indexOf("-- TENANT_SCHEMA_END");
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const block = migration.slice(start, end);
    expect(block).toContain("ALTER TABLE office_dallas.deals");
    expect(block).toContain("bid_board_detached_at timestamptz");
    expect(block).toContain("bid_board_detached_by uuid");
    expect(block).toContain("bid_board_detach_reason text");
    expect(block).toContain("bid_board_detached_was_linked boolean");
    expect(block).toContain("ALTER TABLE office_dallas.bid_board_sync_runs");
    expect(block).toContain("skipped_detached_count INTEGER NOT NULL DEFAULT 0");
  });
});
