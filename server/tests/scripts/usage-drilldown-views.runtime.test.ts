// server/tests/scripts/usage-drilldown-views.runtime.test.ts
// Proves that readViewEvents excludes events from impersonated sessions and cross-user sessions.
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { usageSession, usageViewEvent } from "@trock-crm/shared/schema";
import { readViewEvents } from "../../src/modules/usage/read-service.js";
import { tenantSchemaSql } from "../helpers/tenant-schema-from-drizzle.js";

const U = (s: string) => `00000000-0000-4000-8000-${s.padStart(12, "0")}`;
const REP = U("0001");
const OTHER_USER = U("0002");
const IMPERSONATOR = U("9999");
const DATE = "2026-06-08";

let db: PGlite;
const client = () => ({ query: (sql: string, params?: unknown[]) => db.query(sql, params as any[]) }) as any;

beforeAll(async () => {
  db = new PGlite();
  // Schema from the real Drizzle definitions (#677) — no hand-rolled DDL to drift from prod.
  await db.exec(tenantSchemaSql("office_dallas", [usageSession, usageViewEvent]));

  const normalSession = U("00a1");
  const impersonatedSession = U("00a2");
  const otherUserSession = U("00a3");

  // Normal session owned by REP: impersonator_id IS NULL
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

  // Cross-user-session: session is owned by OTHER_USER, but view event claims user_id = REP.
  // A rogue client POSTing /usage/events with an arbitrary sessionId from another user — the
  // summary path (fetchRawUsageForDay) only loads REP's own sessions, so it never counts this
  // view; the drilldown must also exclude it via the s.user_id = v.user_id JOIN condition.
  await db.exec(`
    INSERT INTO office_dallas.usage_session (id, user_id, impersonator_id)
      VALUES ('${otherUserSession}', '${OTHER_USER}', NULL);
    INSERT INTO office_dallas.usage_view_event (user_id, session_id, at, entity_type, route)
      VALUES ('${REP}', '${otherUserSession}', '${DATE}T14:10:00Z', 'deal', '/deals/cross-user');
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

describe("readViewEvents — cross-user-session exclusion", () => {
  it("does not return a view whose session_id is owned by a different user", async () => {
    // The cross-user-session view has user_id = REP but session owned by OTHER_USER.
    // The s.user_id = v.user_id JOIN condition must exclude it from REP's drilldown.
    const events = await readViewEvents(client(), "office_dallas", REP, DATE);
    const routes = events.map((e) => e.route);
    expect(routes).not.toContain("/deals/cross-user");
    // Only the legitimately-owned, non-impersonated view appears
    expect(routes).toEqual(["/deals/normal"]);
  });
});
