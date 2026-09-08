import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { recordServiceRfpSubmission, serviceRfpJobSql } from "../../../src/modules/deals/service-rfp-submission.js";
import { getRepRosterOptions } from "../../../src/modules/dashboard/service.js";
import { chicagoDate, getServiceRfpReport, mondayOf, summarizeServiceRfps } from "../../../src/modules/reports/service-rfp-service.js";

const OFFICE = "00000000-0000-0000-0000-000000000001";
const OTHER_OFFICE = "00000000-0000-0000-0000-000000000002";
const SELLER = "00000000-0000-0000-0000-000000000011";
const ZERO = "00000000-0000-0000-0000-000000000012";
const DEAL = "00000000-0000-0000-0000-000000000101";
const HIST = "00000000-0000-0000-0000-000000000102";
const MISSING = "00000000-0000-0000-0000-000000000103";
const UNASSIGNED = "00000000-0000-0000-0000-000000000104";
let pg: PGlite;
beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(`
    CREATE TABLE offices (id uuid PRIMARY KEY, slug text, name text);
    CREATE TABLE users (id uuid PRIMARY KEY, display_name text, email text, office_id uuid, generates_sales boolean DEFAULT true, estimates_jobs boolean DEFAULT false, is_active boolean DEFAULT true, is_test_data boolean DEFAULT false);
    CREATE TABLE user_office_access (user_id uuid, office_id uuid);
    CREATE TABLE project_type_config (id uuid PRIMARY KEY, code text);
    CREATE TABLE deals (id uuid PRIMARY KEY, name text, assigned_rep_id uuid, estimator_user_id uuid, project_type text DEFAULT 'service', project_type_id uuid, workflow_route text DEFAULT 'service', is_test_data boolean DEFAULT false, is_active boolean DEFAULT true, rfp_approval_requested_at timestamptz, office_code text DEFAULT 'dallas');
    CREATE TABLE job_queue (id bigint PRIMARY KEY, office_id uuid, job_type text, payload jsonb, created_at timestamptz);
    INSERT INTO offices VALUES ('${OFFICE}', 'dallas', 'Dallas'), ('${OTHER_OFFICE}', 'atlanta', 'Atlanta');
    INSERT INTO users (id, display_name, email, office_id) VALUES ('${SELLER}', 'Original Seller', 'seller@example.com', '${OFFICE}'), ('${ZERO}', 'Zero Seller', 'zero@example.com', '${OFFICE}');
    INSERT INTO deals (id, name, assigned_rep_id) VALUES ('${DEAL}', 'New submission', '${SELLER}'), ('${HIST}', 'Historical submission', '${SELLER}'), ('${MISSING}', 'No evidence', '${SELLER}'), ('${UNASSIGNED}', 'No attributed seller', NULL);
    INSERT INTO job_queue VALUES
      (1, '${OFFICE}', 'rfp_request_delivery', '{"dealId":"${DEAL}"}', '2026-09-07T05:00:00Z'),
      (2, '${OFFICE}', 'rfp_request_delivery', '{"dealId":"${HIST}"}', '2026-09-07T04:59:59Z'),
      (3, '${OTHER_OFFICE}', 'rfp_request_delivery', '{"dealId":"${MISSING}"}', '2026-09-07T05:00:00Z'),
      (4, '${OFFICE}', 'rfp_request_delivery', '{"dealId":"${UNASSIGNED}"}', '2026-09-07T05:00:00Z');
  `);
  await pg.exec(`UPDATE job_queue SET payload = payload || '{"body":{"deal":{"projectType":"4"}}}'::jsonb`);
  await pg.exec(readFileSync(new URL("../../../../migrations/0245_service_rfp_submissions.sql", import.meta.url), "utf8"));
});
afterAll(async () => { await pg?.close(); });

describe("service RFP reporting", () => {
  it("uses the service history index for mixed-job office scans and per-deal lookups", async () => {
    await pg.exec("BEGIN; SET LOCAL enable_seqscan = off");
    try {
      for (const dealFilter of [sql`TRUE`, sql`q.payload->>'dealId' = ${DEAL}`]) {
        const result = await drizzle(pg).execute(sql`EXPLAIN SELECT q.payload->>'dealId', MIN(q.created_at)
          FROM public.job_queue q WHERE q.office_id = ${OFFICE}::uuid
            AND q.job_type IN ('rfp_request_delivery', 'rfp_bidboard_create')
            AND ${serviceRfpJobSql("q")} AND ${dealFilter} GROUP BY q.payload->>'dealId'`);
        expect(JSON.stringify(result.rows)).toContain("job_queue_service_rfp_history_idx");
      }
    } finally { await pg.exec("ROLLBACK"); }
  });
  it("explicit IDs take precedence over same-name and email fallback matches", async () => {
    await pg.exec("BEGIN");
    try {
      await pg.exec(`UPDATE users SET display_name = 'Original Seller' WHERE id = '${ZERO}';
        UPDATE deals SET assigned_rep_id = '${ZERO}' WHERE id IN ('${HIST}', '${MISSING}');`);
      const report = await getServiceRfpReport(drizzle(pg) as never, {
        dateFrom: "2026-08-31", dateTo: "2026-09-13", ownerIds: [SELLER], ownerNames: ["Original Seller"], ownerEmails: ["zero@example.com"],
      }, OFFICE);
      expect(report.deals.map((row) => row.dealId)).toEqual([DEAL]);
      expect(report.missingEvidence).toEqual([]);
      expect(report.reps.map((row) => row.repId)).toEqual([SELLER]);
    } finally { await pg.exec("ROLLBACK"); }
  });
  it("uses Monday in Chicago including the Sunday/Monday boundary and DST", () => {
    expect(mondayOf(chicagoDate("2026-09-07T04:59:59Z"))).toBe("2026-08-31");
    expect(mondayOf(chicagoDate("2026-09-07T05:00:00Z"))).toBe("2026-09-07");
    expect(mondayOf(chicagoDate("2026-03-09T05:00:00Z"))).toBe("2026-03-09");
  });
  it("retains an email-filtered eligible seller with no submissions", async () => {
    await pg.exec(`UPDATE users SET email = 'Zero@Example.com' WHERE id = '${ZERO}'`);
    const report = await getServiceRfpReport(drizzle(pg) as never, {
      dateFrom: "2026-09-07", dateTo: "2026-09-13", ownerIds: [], ownerNames: [], ownerEmails: [" Zero@Example.COM "],
    }, OFFICE);
    expect(report.total).toBe(0);
    expect(report.deals).toEqual([]);
    expect(report.reps).toEqual([
      { repId: ZERO, repName: "Zero Seller", total: 0, weekly: { "2026-09-07": 0 } },
    ]);
  });
  it("atomically captures first submission and preserves it across retries and reassignment", async () => {
    const db = drizzle(pg) as never;
    await recordServiceRfpSubmission(db, OFFICE, DEAL, "first-event", 1);
    await pg.exec(`UPDATE deals SET assigned_rep_id = '${ZERO}' WHERE id = '${DEAL}'; UPDATE users SET is_active = false, generates_sales = false WHERE id = '${SELLER}';
      INSERT INTO job_queue VALUES (5, '${OFFICE}', 'rfp_request_delivery', '{"dealId":"${DEAL}","body":{"deal":{"projectType":"4"}}}', '2026-09-08T05:00:00Z');`);
    await recordServiceRfpSubmission(db, OFFICE, DEAL, "retry-event", 5);
    const row = (await pg.query<{ assigned_rep_id: string; source_event_id: string }>("SELECT assigned_rep_id, source_event_id FROM service_rfp_submissions")).rows;
    expect(row).toEqual([{ assigned_rep_id: SELLER, source_event_id: "first-event" }]);
    const report = await getServiceRfpReport(db, { dateFrom: "2026-08-31", dateTo: "2026-09-13", ownerIds: [], ownerNames: [], ownerEmails: [] }, OFFICE);
    expect(report.total).toBe(3);
    expect(report.historicalCount).toBe(2);
    expect(report.missingEvidenceCount).toBe(1);
    expect(report.deals.find((d) => d.dealId === DEAL)).toMatchObject({ repId: SELLER, week: "2026-09-07", basis: "first_submission" });
    expect(report.deals.find((d) => d.dealId === HIST)).toMatchObject({ week: "2026-08-31", basis: "historical" });
    expect(report.reps.find((r) => r.repId === ZERO)?.total).toBe(0);
    expect(report.reps.find((r) => r.repId === null)?.total).toBe(1);
    const filtered = await getServiceRfpReport(db, { dateFrom: "2026-09-07", dateTo: "2026-09-07", ownerIds: [SELLER], ownerNames: [], ownerEmails: [] }, OFFICE);
    expect(filtered.total).toBe(1);
    expect(filtered.deals[0]?.dealId).toBe(DEAL);
  });
  it("rolls capture back with the surrounding outbox transaction", async () => {
    await pg.exec("BEGIN");
    await recordServiceRfpSubmission(drizzle(pg) as never, OFFICE, UNASSIGNED, "will-rollback", 4);
    await pg.exec("ROLLBACK");
    expect((await pg.query(`SELECT * FROM service_rfp_submissions WHERE deal_id = '${UNASSIGNED}'`)).rows).toHaveLength(0);
  });
  it("rejects malformed date ranges and deduplicates deal evidence", () => {
    expect(() => summarizeServiceRfps([], [], "2026-02-30", "2026-03-01")).toThrow("valid start");
    const row = { dealId: DEAL, dealName: "Job", repId: SELLER, repName: "Seller", submittedAt: "2026-09-07T05:00:00Z", week: null, basis: "first_submission" as const };
    expect(summarizeServiceRfps([row, row], [], "2026-09-07", "2026-09-07").total).toBe(1);
  });
  it("retains historically service submissions after reclassification, without inventing a service handoff from current type", async () => {
    await pg.exec(`UPDATE deals SET project_type = 'roofing', workflow_route = 'normal' WHERE id = '${HIST}';
      UPDATE deals SET rfp_approval_requested_at = '2026-09-07T05:00:00Z' WHERE id = '${MISSING}';
      INSERT INTO job_queue VALUES (6, '${OFFICE}', 'rfp_request_delivery', '{"dealId":"${MISSING}","body":{"deal":{"projectType":"3"}}}', '2026-09-07T05:00:00Z');`);
    const report = await getServiceRfpReport(drizzle(pg) as never, { dateFrom: "2026-08-31", dateTo: "2026-09-13", ownerIds: [], ownerNames: [], ownerEmails: [] }, OFFICE);
    expect(report.deals.some((row) => row.dealId === HIST)).toBe(true);
    expect(report.deals.some((row) => row.dealId === MISSING)).toBe(false);
    expect(report.missingEvidence.some((row) => row.dealId === MISSING)).toBe(true);
  });
  it("new-assignment roster excludes former office members while preserving historical board filters", async () => {
    const foreign = "00000000-0000-0000-0000-000000000013";
    await pg.exec(`INSERT INTO users (id, display_name, office_id) VALUES ('${foreign}', 'Former Office Seller', '${OTHER_OFFICE}');
      UPDATE deals SET assigned_rep_id = '${foreign}' WHERE id = '${MISSING}';`);
    const db = drizzle(pg) as never;
    expect((await getRepRosterOptions(db, OFFICE)).some((rep) => rep.id === foreign)).toBe(true);
    expect((await getRepRosterOptions(db, OFFICE, { assignableOnly: true })).some((rep) => rep.id === foreign)).toBe(false);
    await pg.exec(`INSERT INTO user_office_access VALUES ('${foreign}', '${OFFICE}')`);
    expect((await getRepRosterOptions(db, OFFICE, { assignableOnly: true })).some((rep) => rep.id === foreign)).toBe(true);
  });
  it("the assignable sales roster excludes inactive, non-producing and test users", async () => {
    const inactive = "00000000-0000-0000-0000-000000000021";
    const nonseller = "00000000-0000-0000-0000-000000000022";
    const testUser = "00000000-0000-0000-0000-000000000023";
    await pg.exec(`INSERT INTO users (id, display_name, office_id, is_active, generates_sales, is_test_data) VALUES
      ('${inactive}', 'Inactive Seller', '${OFFICE}', false, true, false),
      ('${nonseller}', 'Not Producing Sales', '${OFFICE}', true, false, false),
      ('${testUser}', 'Test Seller', '${OFFICE}', true, true, true)`);
    const roster = await getRepRosterOptions(drizzle(pg) as never, OFFICE, { assignableOnly: true });
    expect(roster.some((rep) => rep.id === ZERO && rep.group === "sales")).toBe(true);
    expect(roster.some((rep) => [inactive, nonseller, testUser].includes(rep.id))).toBe(false);
  });
});
