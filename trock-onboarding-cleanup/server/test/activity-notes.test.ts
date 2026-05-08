import assert from "node:assert/strict";
import test from "node:test";
import { pool } from "../src/lib/db.js";
import { patchRecord, reassignRecord, skipRecord } from "../src/modules/cleanup/service.js";

type QueryCall = { sql: string; values?: unknown[] };

const actor = { id: "33333333-3333-4333-8333-333333333333", email: "rep@trockgc.com", role: "rep" as const };
const admin = { id: "44444444-4444-4444-8444-444444444444", email: "admin@trockgc.com", role: "admin" as const };
const recordId = "22222222-2222-4222-8222-222222222222";
const targetUserId = "11111111-1111-4111-8111-111111111111";

function detailRow(overrides: Record<string, unknown> = {}) {
  return {
    id: recordId,
    name: "Test Deal",
    cleanup_status: "pending",
    assigned_rep_id: actor.id,
    stage_id: "55555555-5555-4555-8555-555555555555",
    company_id: "66666666-6666-4666-8666-666666666666",
    primary_contact_id: "77777777-7777-4777-8777-777777777777",
    dd_estimate: "10000",
    decision_maker_name: null,
    budget_status: "budgeted_q1",
    stage_id_resolved: null,
    stage_slug: null,
    stage_label: null,
    cleanup_assigned_to: actor.id,
    assignment_reason: "missing_fields",
    assigned_user_id: actor.id,
    assigned_user_email: actor.email,
    assigned_user_display_name: "Rep",
    associated_contact_count: 0,
    hubspot_extra_properties: {},
    ...overrides,
  };
}

function fakeClient(options: {
  detailRows?: Array<Record<string, unknown>>;
  activeUserRows?: Array<{ id: string; email: string; display_name: string }>;
  existingRows?: Array<{ id: string }>;
  beforeOwnerRows?: Array<{ id: string; owner_id: string | null; cleanup_assigned_to: string | null; owner_email?: string | null; owner_display_name?: string | null }>;
} = {}) {
  const calls: QueryCall[] = [];
  const detailRows = [...(options.detailRows ?? [detailRow()])];
  const client = {
    calls,
    released: false,
    async query(sql: string, values?: unknown[]) {
      calls.push({ sql, values });
      if (sql.includes("FROM public.users")) {
        return { rows: options.activeUserRows ?? [{ id: targetUserId, email: "newrep@trockgc.com", display_name: "New Rep" }] };
      }
      if (sql.includes("FROM \"office_dallas\".\"deals\"") && sql.includes("WHERE id = ANY")) {
        return { rows: options.existingRows ?? [{ id: recordId }] };
      }
      if (sql.includes("record.\"assigned_rep_id\"::text AS owner_id")) {
        return {
          rows: options.beforeOwnerRows ?? [{
            id: recordId,
            owner_id: actor.id,
            cleanup_assigned_to: actor.id,
            owner_email: actor.email,
            owner_display_name: "Rep",
          }],
        };
      }
      if (sql.includes("FROM \"office_dallas\".\"deals\" record") && sql.includes("WHERE record.id = $1")) {
        return { rows: [detailRows.shift() ?? detailRow({ phone: "214-555-1234" })] };
      }
      if (sql.includes("UPDATE \"office_dallas\".\"deals\"")) return { rowCount: options.existingRows?.length ?? 1, rows: [] };
      if (sql.includes("UPDATE \"office_dallas\".cleanup_assignments")) return { rowCount: options.existingRows?.length ?? 1, rows: [] };
      return { rows: [] };
    },
    release() {
      this.released = true;
    },
  };
  return client;
}

function activityInsert(calls: QueryCall[]) {
  return calls.find((call) => call.sql.includes("INSERT INTO \"office_dallas\".activities"));
}

test("skipRecord writes a durable CRM activity note with reason, notes, and missing fields", async () => {
  const originalConnect = pool.connect;
  const client = fakeClient({ detailRows: [detailRow()] });
  // @ts-expect-error test stub
  pool.connect = async () => client;
  try {
    await skipRecord("deal", recordId, actor, "contact_left_company", "Contact left in 2025.");
  } finally {
    pool.connect = originalConnect;
  }

  const insert = activityInsert(client.calls);
  assert.ok(insert, "expected cleanup skip to insert a CRM activity note");
  assert.equal(insert.values?.[0], actor.id);
  assert.equal(insert.values?.[1], actor.id);
  assert.equal(insert.values?.[2], "deal");
  assert.equal(insert.values?.[3], recordId);
  assert.equal(insert.values?.[8], "Cleanup skip: Contact left company");
  assert.match(String(insert.values?.[9]), /Contact left in 2025/);
  assert.match(String(insert.values?.[9]), /Missing fields at time of skip: none/);
  assert.equal(client.calls.at(-1)?.sql, "COMMIT");
});

test("patchRecord writes a completion activity note only when completion changed fields", async () => {
  const originalConnect = pool.connect;
  const client = fakeClient({
    detailRows: [
      detailRow({ primary_contact_id: null }),
      detailRow({ primary_contact_id: "77777777-7777-4777-8777-777777777777", cleanup_status: "completed" }),
    ],
  });
  // @ts-expect-error test stub
  pool.connect = async () => client;
  try {
    await patchRecord("deal", recordId, actor, { primary_contact_id: "77777777-7777-4777-8777-777777777777", cleanup_status: "completed" });
  } finally {
    pool.connect = originalConnect;
  }

  const insert = activityInsert(client.calls);
  assert.ok(insert, "expected cleanup completion to insert a CRM activity note");
  assert.equal(insert.values?.[8], "Cleanup completed");
  assert.match(String(insert.values?.[9]), /Fields updated: primary_contact_id \(added\)/);
});

test("reassignRecord writes a durable CRM activity note with previous and new owner context", async () => {
  const originalConnect = pool.connect;
  const client = fakeClient();
  // @ts-expect-error test stub
  pool.connect = async () => client;
  try {
    await reassignRecord("deal", recordId, targetUserId, admin, "relationship owner");
  } finally {
    pool.connect = originalConnect;
  }

  const insert = activityInsert(client.calls);
  assert.ok(insert, "expected reassignment to insert a CRM activity note");
  assert.equal(insert.values?.[8], "Cleanup reassignment");
  assert.match(String(insert.values?.[9]), /Reassigned from Rep to New Rep during data cleanup/);
  assert.match(String(insert.values?.[9]), /Reason: relationship owner/);
});
