import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { getPendingRfpDeals, cancelPendingRfp } from "../../../src/modules/deals/pending-rfp-service.js";

let tdb: any;
let pg: PGlite;

beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(`
    CREATE TABLE pipeline_stage_config (id uuid PRIMARY KEY, slug text, is_active_pipeline boolean DEFAULT true);
    CREATE TABLE users (id uuid PRIMARY KEY, display_name text);
    CREATE TABLE deals (
      id uuid PRIMARY KEY, name text, project_number text, deal_number text, workflow_route text,
      stage_id uuid, is_bid_board_owned boolean DEFAULT false, is_active boolean DEFAULT true,
      is_test_data boolean DEFAULT false, assigned_rep_id uuid,
      rfp_approval_status text, rfp_approval_requested_at timestamptz, rfp_approval_requested_by uuid,
      rfp_declined_reason text,
      rfp_approval_request_event_id uuid, rfp_declined_at timestamptz
    );
    INSERT INTO pipeline_stage_config (id, slug) VALUES
      ('00000000-0000-0000-0000-0000000000aa','opportunity'),
      ('00000000-0000-0000-0000-0000000000bb','estimating');
    INSERT INTO users (id, display_name) VALUES
      ('00000000-0000-0000-0000-0000000000c1','Rep One'),
      ('00000000-0000-0000-0000-0000000000d1','Director One');
    INSERT INTO deals (id,name,workflow_route,stage_id,assigned_rep_id,rfp_approval_status,rfp_approval_requested_at,rfp_approval_requested_by)
      VALUES ('00000000-0000-0000-0000-00000000d001','Older Pending','normal','00000000-0000-0000-0000-0000000000aa','00000000-0000-0000-0000-0000000000c1','pending','2026-06-01T00:00:00Z','00000000-0000-0000-0000-0000000000d1');
    INSERT INTO deals (id,name,workflow_route,stage_id,assigned_rep_id,rfp_approval_status,rfp_approval_requested_at,rfp_declined_reason)
      VALUES ('00000000-0000-0000-0000-00000000d002','Newer Declined','service','00000000-0000-0000-0000-0000000000aa','00000000-0000-0000-0000-0000000000c1','declined','2026-06-10T00:00:00Z','missing docs');
    INSERT INTO deals (id,name,stage_id,rfp_approval_status) VALUES ('00000000-0000-0000-0000-00000000d003','Approved','00000000-0000-0000-0000-0000000000aa','approved');
    INSERT INTO deals (id,name,stage_id,rfp_approval_status,is_bid_board_owned) VALUES ('00000000-0000-0000-0000-00000000d004','Owned','00000000-0000-0000-0000-0000000000aa','pending',true);
    INSERT INTO deals (id,name,stage_id,rfp_approval_status) VALUES ('00000000-0000-0000-0000-00000000d005','Estimating','00000000-0000-0000-0000-0000000000bb','pending');
    INSERT INTO deals (id,name,stage_id,rfp_approval_status,is_test_data) VALUES ('00000000-0000-0000-0000-00000000d006','Test','00000000-0000-0000-0000-0000000000aa','pending',true);
    INSERT INTO deals (id,name,stage_id,rfp_approval_status,is_active) VALUES ('00000000-0000-0000-0000-00000000d007','Inactive','00000000-0000-0000-0000-0000000000aa','pending',false);
  `);
  tdb = drizzle(pg);
});
afterAll(async () => { await pg?.close?.(); });

describe("getPendingRfpDeals", () => {
  it("returns only pending-RFP opportunity deals, oldest-first, with owner/trigger/age fields", async () => {
    const rows = await getPendingRfpDeals(tdb);
    expect(rows.map((r) => r.id)).toEqual([
      "00000000-0000-0000-0000-00000000d001",
      "00000000-0000-0000-0000-00000000d002",
    ]);
    expect(rows[0]).toMatchObject({
      name: "Older Pending", workflowRoute: "normal", subState: "awaiting",
      assignedRepName: "Rep One", triggeredByName: "Director One",
    });
    expect(rows[1]).toMatchObject({ subState: "attention", declineReason: "missing docs" });
  });
});

describe("cancelPendingRfp", () => {
  it("cancelPendingRfp clears the rfp fields so the deal leaves the bucket", async () => {
    const before = await getPendingRfpDeals(tdb);
    expect(before.map((r) => r.id)).toContain("00000000-0000-0000-0000-00000000d002");
    const result = await cancelPendingRfp(tdb, "00000000-0000-0000-0000-00000000d002");
    expect(result).toMatchObject({ id: "00000000-0000-0000-0000-00000000d002" });
    const after = await getPendingRfpDeals(tdb);
    expect(after.map((r) => r.id)).not.toContain("00000000-0000-0000-0000-00000000d002");
  });
});
