// server/tests/scripts/usage-drilldown-views.runtime.test.ts
// Proves that readViewEvents excludes events from impersonated sessions.
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readViewEvents } from "../../src/modules/usage/read-service.js";

const U = (s: string) => `00000000-0000-4000-8000-${s.padStart(12, "0")}`;
const REP = U("0001");
const IMPERSONATOR = U("9999");
const DATE = "2026-06-08";

let db: PGlite;
const client = () => ({ query: (sql: string, params?: unknown[]) => db.query(sql, params as any[]) }) as any;

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    CREATE SCHEMA office_dallas;
    CREATE TABLE office_dallas.usage_session (
      id uuid primary key default gen_random_uuid(),
      user_id uuid,
      started_at timestamptz default now(),
      last_heartbeat_at timestamptz,
      ended_at timestamptz,
      active_seconds int default 0,
      user_agent text,
      impersonator_id uuid,
      created_at timestamptz default now()
    );
    CREATE TABLE office_dallas.usage_view_event (
      id bigserial primary key,
      user_id uuid,
      session_id uuid,
      at timestamptz,
      entity_type text,
      entity_id uuid,
      route text,
      label_snapshot text
    );
  `);

  const normalSession = U("00a1");
  const impersonatedSession = U("00a2");

  // Normal session: impersonator_id IS NULL
  await db.exec(`
    INSERT INTO office_dallas.usage_session (id, user_id, impersonator_id)
      VALUES ('${normalSession}', '${REP}', NULL);
    INSERT INTO office_dallas.usage_view_event (user_id, session_id, at, entity_type, route)
      VALUES ('${REP}', '${normalSession}', '${DATE}T14:00:00Z', 'deal', '/deals/normal');
  `);

  // Impersonated session: impersonator_id is set
  await db.exec(`
    INSERT INTO office_dallas.usage_session (id, user_id, impersonator_id)
      VALUES ('${impersonatedSession}', '${REP}', '${IMPERSONATOR}');
    INSERT INTO office_dallas.usage_view_event (user_id, session_id, at, entity_type, route)
      VALUES ('${REP}', '${impersonatedSession}', '${DATE}T14:05:00Z', 'deal', '/deals/impersonated');
  `);
});

afterAll(async () => { await db?.close(); });

describe("readViewEvents — impersonation exclusion", () => {
  it("returns exactly 1 row (the non-impersonated view), excluding the impersonated session's view", async () => {
    const events = await readViewEvents(client(), "office_dallas", REP, DATE);
    expect(events).toHaveLength(1);
    expect(events[0].route).toBe("/deals/normal");
  });

  it("also filters correctly when entity_type filter is applied", async () => {
    const events = await readViewEvents(client(), "office_dallas", REP, DATE, "deal");
    expect(events).toHaveLength(1);
    expect(events[0].route).toBe("/deals/normal");
  });
});
