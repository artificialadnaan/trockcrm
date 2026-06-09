// server/tests/scripts/usage-rollup.runtime.test.ts
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { rollupOfficeDay, pruneRolledUpRaw } from "../../src/scripts/usage-rollup.js";

const U = (s: string) => `00000000-0000-4000-8000-${s.padStart(12, "0")}`;
const REP = U("0001");
let db: PGlite;
const client = () => ({ query: (sql: string, params?: unknown[]) => db.query(sql, params as any[]) }) as any;

beforeAll(async () => {
  db = new PGlite();
  for (const s of ["office_dallas", "office_atlanta"]) {
    await db.exec(`
      CREATE SCHEMA ${s};
      CREATE TABLE ${s}.usage_session (id uuid primary key default gen_random_uuid(), user_id uuid, started_at timestamptz default now(), last_heartbeat_at timestamptz, ended_at timestamptz, active_seconds int default 0, user_agent text, impersonator_id uuid, created_at timestamptz default now());
      CREATE TABLE ${s}.usage_heartbeat (id bigserial primary key, session_id uuid, user_id uuid, at timestamptz);
      CREATE TABLE ${s}.usage_view_event (id bigserial primary key, user_id uuid, session_id uuid, at timestamptz, entity_type text, entity_id uuid, route text, label_snapshot text);
      CREATE TABLE ${s}.audit_log (id bigserial primary key, table_name text, action text, changed_by uuid, impersonator_id uuid, created_at timestamptz);
      CREATE TABLE ${s}.deal_stage_history (id uuid primary key default gen_random_uuid(), deal_id uuid, to_stage_id uuid, changed_by uuid, created_at timestamptz);
      CREATE TABLE ${s}.activities (id uuid primary key default gen_random_uuid(), type text, responsible_user_id uuid, occurred_at timestamptz, created_at timestamptz);
      CREATE TABLE ${s}.files (id uuid primary key default gen_random_uuid(), uploaded_by uuid, created_at timestamptz);
      CREATE TABLE ${s}.usage_daily (user_id uuid, date date, active_seconds int default 0, session_count int default 0, view_count int default 0, action_count int default 0, breakdown jsonb not null, first_active_at timestamptz, last_active_at timestamptz, rolled_up_at timestamptz not null default now(), primary key (user_id, date));
    `);
    const sid = U(s === "office_dallas" ? "00d1" : "00a1");
    await db.exec(`
      INSERT INTO ${s}.usage_session (id, user_id, started_at) VALUES ('${sid}', '${REP}', '2026-06-01T14:00:00Z');
      INSERT INTO ${s}.usage_heartbeat (session_id, user_id, at) VALUES ('${sid}', '${REP}', '2026-06-01T14:00:30Z');
    `);
  }
});

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
    await pruneRolledUpRaw(client(), "office_dallas", "2026-06-30");
    const { rows } = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM office_dallas.usage_heartbeat`);
    expect(rows[0].n).toBe(0);
  });

  it("prune does NOT delete raw rows for a day with no usage_daily row", async () => {
    await db.exec(`INSERT INTO office_atlanta.usage_heartbeat (session_id, user_id, at) VALUES ('${U("00a1")}', '${REP}', '2026-06-05T10:00:00Z');`);
    await pruneRolledUpRaw(client(), "office_atlanta", "2026-06-30");
    const { rows } = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM office_atlanta.usage_heartbeat WHERE at='2026-06-05T10:00:00Z'`);
    expect(rows[0].n).toBe(1); // un-rolled day survived
  });
});
