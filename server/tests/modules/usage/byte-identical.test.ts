// server/src/modules/usage/byte-identical.test.ts
//
// Spec: SAME raw rows for a COMPLETED (closed) day → live and rollup agree byte-for-byte.
// This is the byte-identical invariant: both the live "today" path (buildLiveDay) and the
// nightly rollup path (rollupOfficeDay → readUsageDaily) call fetchRawUsageForDay then
// computeUsageDaily on the SAME rows, so the persisted shape must round-trip identically.
//
// The frozen 2026-06-01 fixture is used for BOTH paths against the same PGlite DB —
// NOT a live 'today' snapshot, ensuring the fixture never becomes a moving target.

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
import { buildLiveDay, readUsageDaily } from "../../../src/modules/usage/read-service.js";
import { rollupOfficeDay } from "../../../src/scripts/usage-rollup.js";
import { tenantSchemaSql } from "../../helpers/tenant-schema-from-drizzle.js";

const U = (s: string) => `00000000-0000-4000-8000-${s.padStart(12, "0")}`;
const REP = U("0001");
const DATE = "2026-06-01";
const S1 = U("00a1");
const S2 = U("00a2");
// Minimal valid fills for prod NOT NULL columns the rollup/live path doesn't read (the Drizzle-derived
// schema enforces them). Local constants, not a shared factory, so each INSERT stays inline.
const REC = U("0d01"); // audit_log.record_id (NOT NULL)
const ACT_SRC_COLS = "source_entity_type, source_entity_id";
const ACT_SRC_VALS = `'deal', '${U("0de1")}'`;
const FILE_COLS =
  "category, display_name, system_filename, original_filename, mime_type, file_size_bytes, file_extension, r2_key, r2_bucket";
const FILE_VALS = "'photo', 'f.jpg', 'sys.jpg', 'IMG.jpg', 'image/jpeg', 1024, 'jpg', 'r2/k', 'trock-files'";

let db: PGlite;
const client = () => ({ query: (sql: string, params?: unknown[]) => db.query(sql, params as any[]) }) as any;

beforeAll(async () => {
  db = new PGlite();
  // Schema from the real Drizzle definitions (#677): the byte-identical live-vs-rollup proof now runs
  // against prod-accurate types (real audit_action/activity_type enums, real NOT NULL columns,
  // usage_daily's composite (user_id, date) PK) instead of hand-rolled DDL. FKs/indexes omitted.
  await db.exec(
    tenantSchemaSql("office_dallas", [
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

  // Insert a closed-day fixture for 2026-06-01 covering every breakdown field:
  // 2 real sessions, 3 heartbeats (spread over 5 minutes), 2 view events (deal + report),
  // 1 audit insert + 1 audit update, 1 stage move, 1 note activity, 1 upload.
  await db.exec(`
    INSERT INTO office_dallas.usage_session (id, user_id, started_at, impersonator_id)
      VALUES ('${S1}', '${REP}', '${DATE}T14:00:00Z', NULL),
             ('${S2}', '${REP}', '${DATE}T14:05:00Z', NULL);

    INSERT INTO office_dallas.usage_heartbeat (session_id, user_id, at) VALUES
      ('${S1}', '${REP}', '${DATE}T14:00:30Z'),
      ('${S1}', '${REP}', '${DATE}T14:01:00Z'),
      ('${S2}', '${REP}', '${DATE}T14:05:45Z');

    INSERT INTO office_dallas.usage_view_event (user_id, session_id, at, entity_type, route) VALUES
      ('${REP}', '${S1}', '${DATE}T14:00:31Z', 'deal', '/deals/x'),
      ('${REP}', '${S2}', '${DATE}T14:05:46Z', 'report', '/reports/usage');

    INSERT INTO office_dallas.audit_log (table_name, record_id, action, changed_by, impersonator_id, created_at) VALUES
      ('deals', '${REC}', 'insert', '${REP}', NULL, '${DATE}T13:00:00Z'),
      ('leads', '${REC}', 'update', '${REP}', NULL, '${DATE}T13:05:00Z');

    INSERT INTO office_dallas.deal_stage_history (deal_id, to_stage_id, changed_by, created_at) VALUES
      ('${U("0dd1")}', '${U("0501")}', '${REP}', '${DATE}T13:10:00Z');

    INSERT INTO office_dallas.activities (type, ${ACT_SRC_COLS}, responsible_user_id, occurred_at, created_at) VALUES
      ('note', ${ACT_SRC_VALS}, '${REP}', '${DATE}T13:20:00Z', '${DATE}T13:20:00Z');

    INSERT INTO office_dallas.files (${FILE_COLS}, uploaded_by, created_at) VALUES
      (${FILE_VALS}, '${REP}', '${DATE}T13:30:00Z');
  `);
}, 60_000); // generating the full Drizzle-derived schema is heavier than the old hand-rolled DDL; give the hook headroom under parallel CI contention (Codex #715)

afterAll(async () => { await db?.close(); });

describe("live vs rollup byte-identical invariant (closed-day fixture)", () => {
  it("live path and rolled-up-then-read-back produce identical UsageDailyShape for a completed day", async () => {
    // Step 1: live path — fetch raw rows and fold them (same as GET /reports/platform-usage for a past day)
    const live = await buildLiveDay(client(), "office_dallas", REP, DATE);

    // Step 2: rollup path — fetch+fold same rows and upsert to usage_daily
    await rollupOfficeDay(client(), "office_dallas", DATE);

    // Step 3: read back the persisted row
    const persisted = await readUsageDaily(client(), "office_dallas", REP, DATE);

    // Step 4: byte-identical assertion — SAME raw rows must produce SAME shape
    // If this fails it is a REAL reconciliation bug, not a test bug.
    // (rolled_up_at is NOT part of UsageDailyShape / readUsageDaily output, so it does not appear here.)
    expect(JSON.stringify(live)).toBe(JSON.stringify(persisted));
  });

  it("zero-activity reconciliation: live-empty shape is byte-identical to no-row readback", async () => {
    const REP_EMPTY = U("00ff");           // a user with NO rows in any source
    const EMPTY_DAY = "2026-06-02";        // a day with no fixture rows
    const live = await buildLiveDay(client(), "office_dallas", REP_EMPTY, EMPTY_DAY);
    const persisted = await readUsageDaily(client(), "office_dallas", REP_EMPTY, EMPTY_DAY);
    expect(JSON.stringify(live)).toBe(JSON.stringify(persisted));
    // sanity: both are the canonical zeroed shape
    expect(live.activeSeconds).toBe(0);
    expect(live.actionCount).toBe(0);
    expect(live.firstActiveAt).toBeNull();
    expect(live.breakdown.activities).toEqual({});
  });

  it("live shape has the expected field values from the fixture", async () => {
    const live = await buildLiveDay(client(), "office_dallas", REP, DATE);
    expect(live.userId).toBe(REP);
    expect(live.date).toBe(DATE);
    expect(live.sessionCount).toBe(2);
    expect(live.viewCount).toBe(2);
    // creates + edits + stage_moves + uploads + activities(note)
    expect(live.actionCount).toBe(5); // 1 create + 1 edit + 1 stage_move + 1 upload + 1 note
    expect(live.breakdown.deal_views).toBe(1);
    expect(live.breakdown.report_views).toBe(1);
    expect(live.breakdown.creates).toBe(1);
    expect(live.breakdown.edits).toBe(1);
    expect(live.breakdown.stage_moves).toBe(1);
    expect(live.breakdown.uploads).toBe(1);
    expect(live.breakdown.activities).toEqual({ note: 1 });
    expect(live.activeSeconds).toBeGreaterThan(0);
    expect(live.firstActiveAt).toBeTruthy();
    expect(live.lastActiveAt).toBeTruthy();
  });
});
