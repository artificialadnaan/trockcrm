import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";

vi.mock("@trock-crm/shared/schema", async () => import("../../../../shared/src/schema/index.js"));
// Isolate the enqueue + audit side-effects so the test only needs the `deals` + `deal_history` tables.
const mocks = vi.hoisted(() => ({ enqueue: vi.fn(async () => {}), logActivity: vi.fn(async () => {}) }));
vi.mock("../../../src/modules/deals/rfp-enqueue.js", async (orig) => ({ ...((await orig()) as object), enqueueRfpBidBoardCreate: mocks.enqueue }));
vi.mock("../../../src/modules/audit/audit-logger.js", () => ({
  logActivity: mocks.logActivity,
  buildAuditActorFromUser: () => ({ actorType: "user", userId: "x", name: "x", role: "x" }),
}));

import { requestOverrideApproval } from "../../../src/modules/deals/rfp-override-service.js";

const U = (s: string) => `00000000-0000-0000-0000-${s.padStart(12, "0")}`;
const VOTING_DEAL = U("d01"); // rfp_approval_request_id NULL — voting path
const LEGACY_DEAL = U("d02"); // rfp_approval_request_id 4242 — service/type-4 legacy path
const ACTOR = U("a01");

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let tdb: any;
let pg: PGlite;

beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(`
    CREATE TABLE deals (
      id uuid PRIMARY KEY, name text, deal_number text, project_number text,
      rfp_approval_status text, rfp_approval_request_id bigint,
      rfp_approval_request_event_id uuid, assigned_rep_id uuid, hubspot_owner_email text, created_by_user_id uuid,
      rfp_override_state text, rfp_override_error text, rfp_override_reviewed_at timestamptz,
      rfp_override_reviewed_by uuid, rfp_override_decision text, rfp_override_note text, updated_at timestamptz
    );
    CREATE TABLE deal_history (
      deal_id uuid, field_name text, old_value text, new_value text,
      changed_by uuid, source text, reason text, changed_at timestamptz
    );
  `);
  tdb = drizzle(pg);
});

afterAll(async () => { await pg.close(); });

beforeEach(async () => {
  mocks.enqueue.mockClear();
  mocks.logActivity.mockClear();
  await pg.query("DELETE FROM deals");
  await pg.query("DELETE FROM deal_history");
  await pg.query(
    `INSERT INTO deals (id, name, rfp_approval_status, rfp_approval_request_id) VALUES ($1,'Voting deal','declined',NULL),($2,'Legacy deal','declined',4242)`,
    [VOTING_DEAL, LEGACY_DEAL]
  );
});

describe("requestOverrideApproval unification", () => {
  it("voting-path deal (request_id null): enqueues create-from-rfp, does NOT POST SyncHub", async () => {
    const fetchImpl = vi.fn();
    const result = await requestOverrideApproval(
      { tenantDb: tdb, dealId: VOTING_DEAL, officeId: "office-1", actor: { userId: ACTOR, name: "Adam", role: "admin" }, approverEmail: "adam@trockgc.com", note: null },
      { fetchImpl: fetchImpl as unknown as typeof fetch, env: { SYNCHUB_SHARED_SECRET: "s" } }
    );
    expect(result.ok).toBe(true);
    expect(mocks.enqueue).toHaveBeenCalledTimes(1);
    expect(mocks.enqueue.mock.calls[0][0]).toMatchObject({ officeId: "office-1" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("legacy path (request_id present): POSTs SyncHub, does NOT enqueue create-from-rfp", async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 202 }));
    const result = await requestOverrideApproval(
      { tenantDb: tdb, dealId: LEGACY_DEAL, officeId: "office-1", actor: { userId: ACTOR, name: "Adam", role: "admin" }, approverEmail: "adam@trockgc.com", note: null },
      { fetchImpl: fetchImpl as unknown as typeof fetch, env: { SYNCHUB_SHARED_SECRET: "s", SYNCHUB_BASE_URL: "http://synchub.test" } }
    );
    expect(result.ok).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(String(fetchImpl.mock.calls[0][0])).toContain("/api/rfp-requests/4242/override-approve");
    expect(mocks.enqueue).not.toHaveBeenCalled();
  });
});
