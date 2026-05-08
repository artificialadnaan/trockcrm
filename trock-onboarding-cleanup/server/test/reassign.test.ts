import assert from "node:assert/strict";
import test from "node:test";
import { pool } from "../src/lib/db.js";
import { bulkReassignRecords, reassignRecord } from "../src/modules/cleanup/service.js";

type QueryCall = { sql: string; values?: unknown[] };

function fakeClient(options: { activeUserRows?: Array<{ id: string; email: string; display_name: string }>; existingRows?: Array<{ id: string }> } = {}) {
  const calls: QueryCall[] = [];
  const client = {
    calls,
    released: false,
    async query(sql: string, values?: unknown[]) {
      calls.push({ sql, values });
      if (sql.includes("FROM public.users")) return { rows: options.activeUserRows ?? [{ id: "11111111-1111-4111-8111-111111111111", email: "rep@trockgc.com", display_name: "Rep" }] };
      if (sql.includes("FROM \"office_dallas\".\"deals\"") && sql.includes("WHERE id = ANY")) return { rows: options.existingRows ?? [{ id: "22222222-2222-4222-8222-222222222222" }] };
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

test("reassignRecord updates record owner and cleanup assignment in one transaction", async () => {
  const originalConnect = pool.connect;
  const client = fakeClient();
  // @ts-expect-error test stub
  pool.connect = async () => client;
  try {
    await reassignRecord(
      "deal",
      "22222222-2222-4222-8222-222222222222",
      "11111111-1111-4111-8111-111111111111",
      { id: "33333333-3333-4333-8333-333333333333", email: "admin@trockgc.com", role: "admin" },
      "manual routing",
    );
  } finally {
    pool.connect = originalConnect;
  }

  assert.equal(client.calls[0].sql, "BEGIN");
  assert.ok(client.calls.some((call) => call.sql.includes("UPDATE \"office_dallas\".\"deals\"")));
  assert.ok(client.calls.some((call) => call.sql.includes("\"assigned_rep_id\" = $1")));
  assert.ok(client.calls.some((call) => call.sql.includes("UPDATE \"office_dallas\".cleanup_assignments")));
  assert.equal(client.calls.at(-1)?.sql, "COMMIT");
  assert.equal(client.released, true);
});

test("reassignRecord rolls back when target user is not active", async () => {
  const originalConnect = pool.connect;
  const client = fakeClient({ activeUserRows: [] });
  // @ts-expect-error test stub
  pool.connect = async () => client;
  await assert.rejects(
    () =>
      reassignRecord(
        "deal",
        "22222222-2222-4222-8222-222222222222",
        "11111111-1111-4111-8111-111111111111",
        { id: "33333333-3333-4333-8333-333333333333", email: "admin@trockgc.com", role: "admin" },
      ),
    /Target user not found/,
  );
  pool.connect = originalConnect;

  assert.equal(client.calls[0].sql, "BEGIN");
  assert.ok(client.calls.some((call) => call.sql === "ROLLBACK"));
  assert.ok(!client.calls.some((call) => call.sql.includes("UPDATE \"office_dallas\".\"deals\"")));
});

test("bulkReassignRecords caps batches at 500 records", async () => {
  const recordIds = Array.from({ length: 501 }, (_, index) => `22222222-2222-4222-8222-${String(index).padStart(12, "0")}`);
  await assert.rejects(
    () => bulkReassignRecords("deal", recordIds, "11111111-1111-4111-8111-111111111111", { id: "33333333-3333-4333-8333-333333333333", email: "admin@trockgc.com", role: "admin" }),
    /Bulk reassignment is limited to 500 records/,
  );
});
