import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { sql } from "drizzle-orm";
import { getPendingRfpDeals, cancelPendingRfp } from "../../../src/modules/deals/pending-rfp-service.js";

let tdb: any;
let pg: PGlite;

beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(`
    CREATE TABLE pipeline_stage_config (id uuid PRIMARY KEY, slug text, is_active_pipeline boolean DEFAULT true);
    CREATE TABLE users (id uuid PRIMARY KEY, display_name text);
    CREATE TABLE deals (
      id uuid PRIMARY KEY, sales_source_user_id uuid, name text, project_number text, deal_number text, workflow_route text,
      stage_id uuid, is_bid_board_owned boolean DEFAULT false, is_active boolean DEFAULT true,
      is_test_data boolean DEFAULT false, assigned_rep_id uuid,
      rfp_approval_status text, rfp_approval_requested_at timestamptz, rfp_approval_requested_by uuid,
      rfp_declined_reason text, rfp_approval_request_event_id uuid, rfp_declined_at timestamptz,
      rfp_approval_request_id integer, rfp_approval_token text,
      rfp_conflict_reason text, rfp_conflict_with jsonb, rfp_last_attempt_error text,
      rfp_override_state text, rfp_override_decision text, rfp_override_error text,
      rfp_override_note text, rfp_override_reviewed_at timestamptz, rfp_override_reviewed_by uuid,
      updated_at timestamptz DEFAULT now()
    );
    INSERT INTO pipeline_stage_config (id, slug) VALUES
      ('00000000-0000-0000-0000-0000000000aa','opportunity'),
      ('00000000-0000-0000-0000-0000000000dd','dd'),
      ('00000000-0000-0000-0000-0000000000bb','estimating');
    INSERT INTO users (id, display_name) VALUES
      ('00000000-0000-0000-0000-0000000000c1','Rep One'),
      ('00000000-0000-0000-0000-0000000000d1','Director One');
    INSERT INTO deals (id,name,workflow_route,stage_id,assigned_rep_id,rfp_approval_status,rfp_approval_requested_at,rfp_approval_requested_by)
      VALUES ('00000000-0000-0000-0000-00000000d001','Older Pending','normal','00000000-0000-0000-0000-0000000000aa','00000000-0000-0000-0000-0000000000c1','pending','2026-06-01T00:00:00Z','00000000-0000-0000-0000-0000000000d1');
    -- Seeds a non-null stale override block (state/error/decision) — decision is a non-reconfirmed value
    -- (still cancellable) so the cancel-clear assertion on rfp_override_decision is load-bearing.
    INSERT INTO deals (id,name,workflow_route,stage_id,assigned_rep_id,rfp_approval_status,rfp_approval_requested_at,rfp_declined_reason,rfp_approval_request_id,rfp_approval_token,rfp_last_attempt_error,rfp_override_state,rfp_override_error,rfp_override_decision,updated_at)
      VALUES ('00000000-0000-0000-0000-00000000d002','Newer Declined','service','00000000-0000-0000-0000-0000000000aa','00000000-0000-0000-0000-0000000000c1','declined','2026-06-10T00:00:00Z','missing docs',42,'tok-xyz','boom','failed','prev override error','override_approved','2020-01-01T00:00:00Z');
    INSERT INTO deals (id,name,stage_id,rfp_approval_status) VALUES ('00000000-0000-0000-0000-00000000d003','Approved','00000000-0000-0000-0000-0000000000aa','approved');
    INSERT INTO deals (id,name,stage_id,rfp_approval_status,is_bid_board_owned) VALUES ('00000000-0000-0000-0000-00000000d004','Owned','00000000-0000-0000-0000-0000000000aa','pending',true);
    INSERT INTO deals (id,name,stage_id,rfp_approval_status) VALUES ('00000000-0000-0000-0000-00000000d005','Estimating','00000000-0000-0000-0000-0000000000bb','pending');
    INSERT INTO deals (id,name,stage_id,rfp_approval_status,is_test_data) VALUES ('00000000-0000-0000-0000-00000000d006','Test','00000000-0000-0000-0000-0000000000aa','pending',true);
    INSERT INTO deals (id,name,stage_id,rfp_approval_status,is_active) VALUES ('00000000-0000-0000-0000-00000000d007','Inactive','00000000-0000-0000-0000-0000000000aa','pending',false);
    -- declined but the override flow upheld the denial → resolved terminal, must be excluded
    INSERT INTO deals (id,name,stage_id,rfp_approval_status,rfp_override_decision) VALUES ('00000000-0000-0000-0000-00000000d008','Reconfirmed','00000000-0000-0000-0000-0000000000aa','declined','denial_reconfirmed');
    -- pending RFP whose stage is the legacy "dd" alias (canonicalizes to opportunity) → must be included
    INSERT INTO deals (id,name,workflow_route,stage_id,rfp_approval_status,rfp_approval_requested_at) VALUES ('00000000-0000-0000-0000-00000000d009','Legacy DD','normal','00000000-0000-0000-0000-0000000000dd','pending','2026-06-20T00:00:00Z');
    -- declined but override-approval is in flight (being created on Bid Board) → not actionable, excluded
    INSERT INTO deals (id,name,stage_id,rfp_approval_status,rfp_override_state) VALUES ('00000000-0000-0000-0000-00000000d010','OverrideApproving','00000000-0000-0000-0000-0000000000aa','declined','approving');
  `);
  tdb = drizzle(pg);
});
afterAll(async () => { await pg?.close?.(); });

describe("getPendingRfpDeals", () => {
  it("returns pending-RFP opportunity-family deals oldest-first; excludes approved/owned/wrong-stage/test/inactive/reconfirmed-denial", async () => {
    const rows = await getPendingRfpDeals(tdb);
    expect(rows.map((r) => r.id)).toEqual([
      "00000000-0000-0000-0000-00000000d001",
      "00000000-0000-0000-0000-00000000d002",
      "00000000-0000-0000-0000-00000000d009", // legacy "dd" alias is included
    ]);
    expect(rows.map((r) => r.id)).not.toContain("00000000-0000-0000-0000-00000000d008"); // reconfirmed denial excluded
    expect(rows.map((r) => r.id)).not.toContain("00000000-0000-0000-0000-00000000d010"); // override-approving excluded
    expect(rows[0]).toMatchObject({
      name: "Older Pending", workflowRoute: "normal", subState: "awaiting",
      assignedRepName: "Rep One", triggeredByName: "Director One",
    });
    // d002 is declined AND carries a lingering rfp_last_attempt_error="boom"; the reason must be the
    // status-specific decline note, not the stale send-failure error.
    expect(rows[1]).toMatchObject({ subState: "attention", reason: "missing docs" });
  });

  it("surfaces a status-specific reason for conflict (rfp_conflict_reason) and send_failed (rfp_last_attempt_error)", async () => {
    await pg.exec(`
      INSERT INTO deals (id,name,stage_id,rfp_approval_status,rfp_approval_requested_at,rfp_conflict_reason,rfp_last_attempt_error)
        VALUES ('00000000-0000-0000-0000-00000000d020','Conflicted','00000000-0000-0000-0000-0000000000aa','conflict','2026-06-30T00:00:00Z','already linked elsewhere','stale-err');
      INSERT INTO deals (id,name,stage_id,rfp_approval_status,rfp_approval_requested_at,rfp_last_attempt_error)
        VALUES ('00000000-0000-0000-0000-00000000d021','SendFailed','00000000-0000-0000-0000-0000000000aa','send_failed','2026-07-01T00:00:00Z','SMTP 550 rejected');
    `);
    const rows = await getPendingRfpDeals(tdb);
    const byId = new Map(rows.map((r) => [r.id, r]));
    // conflict → conflict reason (never the lingering last_attempt_error)
    expect(byId.get("00000000-0000-0000-0000-00000000d020")).toMatchObject({
      subState: "attention", reason: "already linked elsewhere",
    });
    // send_failed → last attempt error
    expect(byId.get("00000000-0000-0000-0000-00000000d021")).toMatchObject({
      subState: "attention", reason: "SMTP 550 rejected",
    });
  });
});

describe("cancelPendingRfp", () => {
  it("clears the whole RFP cycle (status, request id, token, decline reason) for an attention-state deal", async () => {
    const result = await cancelPendingRfp(tdb, "00000000-0000-0000-0000-00000000d002");
    expect(result).toMatchObject({ id: "00000000-0000-0000-0000-00000000d002" });

    const res = await tdb.execute(sql`
      SELECT rfp_approval_status, rfp_approval_request_id, rfp_approval_token, rfp_declined_reason,
             rfp_last_attempt_error, rfp_override_decision, rfp_override_state, rfp_override_error, updated_at
      FROM deals WHERE id = '00000000-0000-0000-0000-00000000d002'`);
    const row = (Array.isArray(res) ? res : res.rows)[0];
    expect(row.rfp_approval_status).toBeNull();
    expect(row.rfp_approval_request_id).toBeNull();
    expect(row.rfp_approval_token).toBeNull();
    expect(row.rfp_declined_reason).toBeNull();
    expect(row.rfp_last_attempt_error).toBeNull();
    // The override block is part of the "whole RFP cycle" — a stale failed-override must be cleared too,
    // so a late override callback/job can't resurrect override state on a cancelled deal.
    expect(row.rfp_override_decision).toBeNull();
    expect(row.rfp_override_state).toBeNull();
    expect(row.rfp_override_error).toBeNull();
    // Cancel bumps updated_at off its seeded 2020 value so the deal isn't stale in updated_at-ordered lists.
    expect(new Date(row.updated_at).getTime()).toBeGreaterThan(new Date("2020-01-01T00:00:00Z").getTime());

    const after = await getPendingRfpDeals(tdb);
    expect(after.map((r) => r.id)).not.toContain("00000000-0000-0000-0000-00000000d002");
  });

  it("refuses to cancel an in-flight (awaiting) RFP", async () => {
    expect(await cancelPendingRfp(tdb, "00000000-0000-0000-0000-00000000d001")).toBeNull();
  });

  it("refuses to cancel a re-confirmed denial", async () => {
    expect(await cancelPendingRfp(tdb, "00000000-0000-0000-0000-00000000d008")).toBeNull();
  });

  it("refuses to cancel a deal whose override-approval is in flight", async () => {
    expect(await cancelPendingRfp(tdb, "00000000-0000-0000-0000-00000000d010")).toBeNull();
  });

  it("re-binds rep ownership: clears only when requireOwnerId matches the current assignee", async () => {
    await pg.exec(`
      INSERT INTO deals (id,name,stage_id,assigned_rep_id,rfp_approval_status,rfp_declined_reason)
        VALUES ('00000000-0000-0000-0000-00000000d032','OwnedDeclined','00000000-0000-0000-0000-0000000000aa','00000000-0000-0000-0000-0000000000c1','declined','reason');
    `);
    // A rep who is NOT the current assignee (e.g. after a reassignment) → no match, nothing cleared.
    expect(
      await cancelPendingRfp(tdb, "00000000-0000-0000-0000-00000000d032", "00000000-0000-0000-0000-0000000000c9")
    ).toBeNull();
    const stillThere = await tdb.execute(sql`
      SELECT rfp_approval_status FROM deals WHERE id = '00000000-0000-0000-0000-00000000d032'`);
    expect((Array.isArray(stillThere) ? stillThere : stillThere.rows)[0].rfp_approval_status).toBe("declined");
    // The current assignee → matches, clears.
    expect(
      await cancelPendingRfp(tdb, "00000000-0000-0000-0000-00000000d032", "00000000-0000-0000-0000-0000000000c1")
    ).toMatchObject({ id: "00000000-0000-0000-0000-00000000d032" });
  });

  it("refuses to clear a soft-deleted (is_active=false) declined deal", async () => {
    await pg.exec(`
      INSERT INTO deals (id,name,stage_id,rfp_approval_status,rfp_declined_reason,is_active)
        VALUES ('00000000-0000-0000-0000-00000000d031','DeletedDeclined','00000000-0000-0000-0000-0000000000aa','declined','left stale',false);
    `);
    expect(await cancelPendingRfp(tdb, "00000000-0000-0000-0000-00000000d031")).toBeNull();
    const res = await tdb.execute(sql`
      SELECT rfp_approval_status, rfp_declined_reason FROM deals
      WHERE id = '00000000-0000-0000-0000-00000000d031'`);
    const row = (Array.isArray(res) ? res : res.rows)[0];
    expect(row.rfp_approval_status).toBe("declined"); // unchanged — not cleared on a deleted record
    expect(row.rfp_declined_reason).toBe("left stale");
  });

  it("refuses to clear a declined deal that has advanced out of Opportunity (stage guard in WHERE)", async () => {
    // declined + attention status, but sitting in the estimating stage (not opportunity-family) — the
    // atomic WHERE's stage guard must reject it, leaving its RFP fields untouched (TOCTOU backstop).
    await pg.exec(`
      INSERT INTO deals (id,name,stage_id,rfp_approval_status,rfp_declined_reason)
        VALUES ('00000000-0000-0000-0000-00000000d030','AdvancedDeclined','00000000-0000-0000-0000-0000000000bb','declined','left stale');
    `);
    expect(await cancelPendingRfp(tdb, "00000000-0000-0000-0000-00000000d030")).toBeNull();
    const res = await tdb.execute(sql`
      SELECT rfp_approval_status, rfp_declined_reason FROM deals
      WHERE id = '00000000-0000-0000-0000-00000000d030'`);
    const row = (Array.isArray(res) ? res : res.rows)[0];
    expect(row.rfp_approval_status).toBe("declined"); // unchanged — not cleared
    expect(row.rfp_declined_reason).toBe("left stale");
  });
});
