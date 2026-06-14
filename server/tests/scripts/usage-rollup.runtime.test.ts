// server/tests/scripts/usage-rollup.runtime.test.ts
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  activities,
  auditLog,
  dealStageHistory,
  files,
  usageDaily,
  usageHeartbeat,
  usageSession,
  usageViewEvent,
} from "@trock-crm/shared/schema";
import { rollupOfficeDay, pruneRolledUpRaw } from "../../src/scripts/usage-rollup.js";
import { tenantSchemaSql } from "../helpers/tenant-schema-from-drizzle.js";

const U = (s: string) => `00000000-0000-4000-8000-${s.padStart(12, "0")}`;
const REP = U("0001");
let db: PGlite;
const client = () => ({ query: (sql: string, params?: unknown[]) => db.query(sql, params as any[]) }) as any;

beforeAll(async () => {
  db = new PGlite();
  for (const s of ["office_dallas", "office_atlanta"]) {
    // Schema generated from the REAL Drizzle definitions (#677): audit_log.action and activities.type
    // are the real enums, usage_daily keeps its composite (user_id, date) PK — all verbatim from the
    // table objects, so the rollup's reads run against prod-accurate types. FKs/indexes omitted.
    await db.exec(
      tenantSchemaSql(s, [
        usageSession,
        usageHeartbeat,
        usageViewEvent,
        auditLog,
        dealStageHistory,
        activities,
        files,
        usageDaily,
      ]),
    );
    const sid = U(s === "office_dallas" ? "00d1" : "00a1");
    await db.exec(`
      INSERT INTO ${s}.usage_session (id, user_id, started_at) VALUES ('${sid}', '${REP}', '2026-06-01T14:00:00Z');
      INSERT INTO ${s}.usage_heartbeat (session_id, user_id, at) VALUES ('${sid}', '${REP}', '2026-06-01T14:00:30Z');
    `);
  }
}, 60_000); // generating the full Drizzle-derived schema (twice, fan-out) is heavier than the old hand-rolled DDL; give the hook headroom under parallel CI contention (Codex #715)

afterAll(async () => { await db?.close(); });

describe("usage rollup fan-out + gated prune", () => {
  it("rolls up a completed day in EVERY office schema", async () => {
    for (const s of ["office_dallas", "office_atlanta"]) {
      await rollupOfficeDay(client(), s, "2026-06-01");
      const { rows } = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${s}.usage_daily WHERE date='2026-06-01'`);
      expect(rows[0].n).toBe(1);
    }
  });

  it("prune deletes raw rows ONLY for rolled-up days older than 14 days", async () => {
    // Insert a view_event for the same rolled-up day to verify it is also pruned.
    const sid = U("00d1");
    await db.exec(`INSERT INTO office_dallas.usage_view_event (user_id, session_id, at, entity_type, route, label_snapshot) VALUES ('${REP}', '${sid}', '2026-06-01T14:01:00Z', 'page', '/pipeline', null);`);

    await pruneRolledUpRaw(client(), "office_dallas", "2026-06-30");

    const { rows: hb } = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM office_dallas.usage_heartbeat WHERE at='2026-06-01T14:00:30Z'`);
    expect(hb[0].n).toBe(0);
    const { rows: ve } = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM office_dallas.usage_view_event WHERE at='2026-06-01T14:01:00Z'`);
    expect(ve[0].n).toBe(0);
  });

  it("prune does NOT delete raw rows for a day with no usage_daily row", async () => {
    await db.exec(`INSERT INTO office_atlanta.usage_heartbeat (session_id, user_id, at) VALUES ('${U("00a1")}', '${REP}', '2026-06-05T10:00:00Z');`);
    await pruneRolledUpRaw(client(), "office_atlanta", "2026-06-30");
    const { rows } = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM office_atlanta.usage_heartbeat WHERE at='2026-06-05T10:00:00Z'`);
    expect(rows[0].n).toBe(1); // un-rolled day survived
  });

  it("prune matches business-day usage_daily row for heartbeat whose UTC-date differs from business-date", async () => {
    // 2026-06-06T02:00:00Z = 2026-06-05 21:00 America/Chicago → business day 2026-06-05 (UTC day 2026-06-06).
    // Under the old UTC derivation the prune would look for a usage_daily row on 2026-06-06, find none, and
    // leave the raw row un-pruned (a leak). With BUSINESS_TIMEZONE it correctly matches the 2026-06-05 row.
    const REP_B = U("00b5");
    const SID_B = U("00b6");
    // Session started on business day 2026-06-05 (entirely within Chicago 06-05).
    await db.exec(`INSERT INTO office_dallas.usage_session (id, user_id, started_at) VALUES ('${SID_B}', '${REP_B}', '2026-06-05T20:00:00Z');`);
    // Heartbeat at 2026-06-06T02:00:00Z: UTC day 2026-06-06, Chicago day 2026-06-05.
    await db.exec(`INSERT INTO office_dallas.usage_heartbeat (session_id, user_id, at) VALUES ('${SID_B}', '${REP_B}', '2026-06-06T02:00:00Z');`);

    // Roll up business day 2026-06-05 → writes usage_daily row on date 2026-06-05 for REP_B.
    await rollupOfficeDay(client(), "office_dallas", "2026-06-05");
    const { rows: dailyRows } = await db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM office_dallas.usage_daily WHERE user_id='${REP_B}' AND date='2026-06-05'`,
    );
    expect(dailyRows[0].n).toBe(1); // confirm the usage_daily row was written

    // Prune with asOf 2026-06-30 (the heartbeat at 06-06T02Z is >14 days older than 06-30 Chicago midnight).
    await pruneRolledUpRaw(client(), "office_dallas", "2026-06-30");

    // The heartbeat MUST be deleted: the prune found the matching usage_daily row via the business-tz date.
    const { rows: afterPrune } = await db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM office_dallas.usage_heartbeat WHERE user_id='${REP_B}' AND at='2026-06-06T02:00:00Z'`,
    );
    expect(afterPrune[0].n).toBe(0); // leaked under UTC; deleted under BUSINESS_TIMEZONE
  });

  it("rolls up a user whose only signal that day is a heartbeat (no session started, no writes)", async () => {
    const REP2 = U("0002");
    // Session started the PRIOR day (cross-midnight) — not started on 2026-06-10
    await db.exec(`INSERT INTO office_dallas.usage_session (id, user_id, started_at) VALUES ('${U("0bb1")}', '${REP2}', '2026-06-09T23:58:00Z');`);
    // Heartbeat on 2026-06-10 in office_dallas; no session started that day, no audit/activity/etc.
    await db.exec(`INSERT INTO office_dallas.usage_heartbeat (session_id, user_id, at) VALUES ('${U("0bb1")}', '${REP2}', '2026-06-10T14:00:30Z');`);
    await rollupOfficeDay(client(), "office_dallas", "2026-06-10");
    const { rows } = await db.query<{ n: number; active: number }>(
      `SELECT count(*)::int AS n, COALESCE(max(active_seconds),0)::int AS active FROM office_dallas.usage_daily WHERE user_id='${REP2}' AND date='2026-06-10'`,
    );
    expect(rows[0].n).toBe(1);          // user was discovered and rolled up
    expect(rows[0].active).toBeGreaterThan(0); // heartbeat produced active time
  });
});
