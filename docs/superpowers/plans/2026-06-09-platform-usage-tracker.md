# Platform Usage Tracker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a Platform Usage report (new page under Reports) that breaks down, per sales rep, daily and weekly **active time**, **actions taken** (changes/entries across the CRM), and **views**, with directors/admins seeing all reps and reps seeing only themselves.

**Architecture:** A new `usage` server module collects browser telemetry (sessions, heartbeats, view events) via thin POST endpoints; a **pure `computeUsageDaily` function** folds telemetry + existing write sources (`auditLog`, `deal_stage_history`, `activities`, `files`) into a per-rep daily shape. Both the live "today" read path and a nightly per-office rollup script call that one function, so live and rolled-up numbers agree on a completed day. A React hook mounted once in the app shell drives collection; a new Reports page renders a team summary + leaderboard + per-rep drilldown.

**Tech Stack:** Node/TypeScript, Express, Drizzle ORM, Postgres (per-office schemas via `search_path`), Vitest + PGlite (server), React + Vite + React Router + custom `api()` client (client), Vitest + `renderToStaticMarkup` (client).

**Spec:** `docs/superpowers/specs/2026-06-09-platform-usage-tracker-design.md` — read it before starting. Key invariants: shared pure aggregation function; interval-merge for multi-tab dedup lives *inside* it; `HEARTBEAT_INTERVAL_S=30`, `HEARTBEAT_GRACE_S=5`; multi-source action registry with per-source contract test; prune gated on `rolled_up_at`; server-enforced rep-self scoping on both read endpoints; impersonator stamped on `usage_session`; byte-identical invariant tested with a **closed-day fixture**.

---

## File Structure

**Shared schema (Drizzle):**
- Create `shared/src/schema/tenant/usage-session.ts` — `usage_session` table
- Create `shared/src/schema/tenant/usage-heartbeat.ts` — `usage_heartbeat` table
- Create `shared/src/schema/tenant/usage-view-event.ts` — `usage_view_event` table
- Create `shared/src/schema/tenant/usage-daily.ts` — `usage_daily` table
- Modify `shared/src/schema/index.ts` — export the four tables

**Migration:**
- Create `migrations/0157_usage_tracking.sql` — four tables in every office schema + new-tenant template block

**Server `usage` module:**
- Create `server/src/modules/usage/constants.ts` — pinned constants
- Create `server/src/modules/usage/types.ts` — raw-input + output types
- Create `server/src/modules/usage/interval-merge.ts` — pure active-window merge
- Create `server/src/modules/usage/action-sources.ts` — `USAGE_ACTION_SOURCES` registry
- Create `server/src/modules/usage/aggregate.ts` — `computeUsageDaily` (pure spine)
- Create `server/src/modules/usage/raw-fetch.ts` — `fetchRawUsageForDay` (DB → raw input)
- Create `server/src/modules/usage/read-service.ts` — summary/leaderboard/drilldown builders
- Create `server/src/modules/usage/collection-service.ts` — session/heartbeat/event writers
- Create `server/src/modules/usage/routes.ts` — `/api/usage/*` collection endpoints
- Modify `server/src/route-access-policy.ts` — add `/usage` mount
- Modify `server/src/app.ts` — register `usageRoutes`
- Modify `server/src/modules/reports/routes.ts` — add `GET /platform-usage` + `/platform-usage/drilldown`

**Rollup script:**
- Create `server/src/scripts/usage-rollup.ts` — per-office rollup + gated prune
- Modify `server/package.json` — `usage:rollup` script

**Client:**
- Create `client/src/hooks/use-platform-usage-tracker.ts` — collection hook
- Modify `client/src/components/layout/app-shell.tsx` — mount the hook
- Create `client/src/hooks/use-platform-usage-report.ts` — read hook
- Create `client/src/pages/reports/platform-usage-page.tsx` — the page
- Modify `client/src/App.tsx` — route registration
- Modify `client/src/pages/reports/reports-page.tsx` — Reports index card

**Tests** are colocated next to each unit (server: `*.test.ts` beside source or under `server/tests/`; client: `*.test.tsx` beside component).

---

## Task 1: Usage Drizzle schema tables

**Files:**
- Create: `shared/src/schema/tenant/usage-session.ts`
- Create: `shared/src/schema/tenant/usage-heartbeat.ts`
- Create: `shared/src/schema/tenant/usage-view-event.ts`
- Create: `shared/src/schema/tenant/usage-daily.ts`
- Modify: `shared/src/schema/index.ts`
- Test: `shared/src/schema/tenant/usage-schema.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// shared/src/schema/tenant/usage-schema.test.ts
import { describe, expect, it } from "vitest";
import { usageSession, usageHeartbeat, usageViewEvent, usageDaily } from "../index.js";

function columnNames(table: Record<string, unknown>): string[] {
  // Drizzle table columns are enumerable own-props with a `.name`
  return Object.values(table)
    .filter((c): c is { name: string } => !!c && typeof c === "object" && "name" in (c as object))
    .map((c) => c.name);
}

describe("usage schema tables", () => {
  it("usage_session has the expected columns", () => {
    const cols = columnNames(usageSession);
    expect(cols).toEqual(
      expect.arrayContaining([
        "id", "user_id", "started_at", "last_heartbeat_at", "ended_at",
        "active_seconds", "user_agent", "impersonator_id", "created_at",
      ]),
    );
  });

  it("usage_heartbeat references a session and is server-stamped", () => {
    expect(columnNames(usageHeartbeat)).toEqual(
      expect.arrayContaining(["id", "session_id", "user_id", "at"]),
    );
  });

  it("usage_view_event captures entity + route", () => {
    expect(columnNames(usageViewEvent)).toEqual(
      expect.arrayContaining(["id", "user_id", "session_id", "at", "entity_type", "entity_id", "route", "label_snapshot"]),
    );
  });

  it("usage_daily is the forever rollup with a rolled_up_at gate", () => {
    expect(columnNames(usageDaily)).toEqual(
      expect.arrayContaining([
        "user_id", "date", "active_seconds", "session_count", "view_count",
        "action_count", "breakdown", "first_active_at", "last_active_at", "rolled_up_at",
      ]),
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run shared/src/schema/tenant/usage-schema.test.ts`
Expected: FAIL — `usageSession` (etc.) is not exported from `../index.js`.

- [ ] **Step 3: Create the four schema files**

```ts
// shared/src/schema/tenant/usage-session.ts
import { pgTable, uuid, integer, varchar, timestamp, index } from "drizzle-orm/pg-core";

export const usageSession = pgTable(
  "usage_session",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id").notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }).defaultNow().notNull(),
    lastHeartbeatAt: timestamp("last_heartbeat_at", { withTimezone: true }),
    endedAt: timestamp("ended_at", { withTimezone: true }),
    activeSeconds: integer("active_seconds").default(0).notNull(),
    userAgent: varchar("user_agent", { length: 500 }),
    impersonatorId: uuid("impersonator_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("usage_session_user_started_idx").on(table.userId, table.startedAt),
  ],
);
```

```ts
// shared/src/schema/tenant/usage-heartbeat.ts
import { pgTable, bigserial, uuid, timestamp, index } from "drizzle-orm/pg-core";

export const usageHeartbeat = pgTable(
  "usage_heartbeat",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    sessionId: uuid("session_id").notNull(),
    userId: uuid("user_id").notNull(),
    at: timestamp("at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("usage_heartbeat_user_at_idx").on(table.userId, table.at),
    index("usage_heartbeat_session_idx").on(table.sessionId),
  ],
);
```

```ts
// shared/src/schema/tenant/usage-view-event.ts
import { pgTable, bigserial, uuid, text, timestamp, index } from "drizzle-orm/pg-core";

export const usageViewEvent = pgTable(
  "usage_view_event",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    userId: uuid("user_id").notNull(),
    sessionId: uuid("session_id").notNull(),
    at: timestamp("at", { withTimezone: true }).defaultNow().notNull(),
    entityType: text("entity_type").notNull(), // 'deal' | 'lead' | 'report' | 'page'
    entityId: uuid("entity_id"),
    route: text("route").notNull(),
    labelSnapshot: text("label_snapshot"),
  },
  (table) => [
    index("usage_view_event_user_at_idx").on(table.userId, table.at),
  ],
);
```

```ts
// shared/src/schema/tenant/usage-daily.ts
import { pgTable, uuid, date, integer, jsonb, timestamp, primaryKey } from "drizzle-orm/pg-core";

export const usageDaily = pgTable(
  "usage_daily",
  {
    userId: uuid("user_id").notNull(),
    date: date("date").notNull(),
    activeSeconds: integer("active_seconds").default(0).notNull(),
    sessionCount: integer("session_count").default(0).notNull(),
    viewCount: integer("view_count").default(0).notNull(),
    actionCount: integer("action_count").default(0).notNull(),
    breakdown: jsonb("breakdown").notNull(),
    firstActiveAt: timestamp("first_active_at", { withTimezone: true }),
    lastActiveAt: timestamp("last_active_at", { withTimezone: true }),
    rolledUpAt: timestamp("rolled_up_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [primaryKey({ columns: [table.userId, table.date] })],
);
```

- [ ] **Step 4: Export from the schema index**

In `shared/src/schema/index.ts`, add (next to the other tenant exports):

```ts
export * from "./tenant/usage-session.js";
export * from "./tenant/usage-heartbeat.js";
export * from "./tenant/usage-view-event.js";
export * from "./tenant/usage-daily.js";
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run shared/src/schema/tenant/usage-schema.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 6: Typecheck shared**

Run: `npm run typecheck --workspace=shared` (or `cd shared && npx tsc --noEmit`)
Expected: clean.

- [ ] **Step 7: Commit**

```bash
git add shared/src/schema/tenant/usage-*.ts shared/src/schema/index.ts shared/src/schema/tenant/usage-schema.test.ts
git commit -m "feat(usage): add usage tracking Drizzle schema (session/heartbeat/view/daily)"
```

---

## Task 2: Migration 0157 — usage tables in every office schema

**Files:**
- Create: `migrations/0157_usage_tracking.sql`
- Test: `server/tests/scripts/usage-migration.runtime.test.ts`

Mirror the `DO $tenant$` loop + `-- TENANT_SCHEMA_START/END` template from `migrations/0153_deal_change_orders.sql`.

- [ ] **Step 1: Write the failing PGlite test**

```ts
// server/tests/scripts/usage-migration.runtime.test.ts
import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

let db: PGlite;

beforeAll(async () => {
  db = new PGlite();
  // The migration loops over existing office_* schemas; create one first.
  await db.exec(`CREATE SCHEMA office_dallas;`);
  const sql = readFileSync(new URL("../../../migrations/0157_usage_tracking.sql", import.meta.url), "utf8");
  await db.exec(sql);
});

afterAll(async () => {
  await db?.close();
});

describe("0157_usage_tracking migration", () => {
  it("creates all four usage tables in office_dallas", async () => {
    const { rows } = await db.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = 'office_dallas' AND table_name LIKE 'usage_%' ORDER BY table_name`,
    );
    expect(rows.map((r) => r.table_name)).toEqual([
      "usage_daily", "usage_heartbeat", "usage_session", "usage_view_event",
    ]);
  });

  it("usage_daily has a composite primary key on (user_id, date)", async () => {
    const { rows } = await db.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM information_schema.table_constraints
       WHERE table_schema='office_dallas' AND table_name='usage_daily' AND constraint_type='PRIMARY KEY'`,
    );
    expect(rows[0].count).toBe(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run server/tests/scripts/usage-migration.runtime.test.ts`
Expected: FAIL — migration file does not exist (ENOENT).

- [ ] **Step 3: Write the migration**

```sql
-- migrations/0157_usage_tracking.sql
-- Platform Usage tracker: per-office telemetry + daily rollup tables.

-- Existing tenants: create the tables in every office_* schema.
DO $tenant$
DECLARE
  schema_name text;
BEGIN
  FOR schema_name IN
    SELECT nspname FROM pg_namespace WHERE nspname LIKE 'office\_%' ESCAPE '\' ORDER BY nspname
  LOOP
    EXECUTE format(
      $sql$
        CREATE TABLE IF NOT EXISTS %1$I.usage_session (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          user_id UUID NOT NULL,
          started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          last_heartbeat_at TIMESTAMPTZ,
          ended_at TIMESTAMPTZ,
          active_seconds INTEGER NOT NULL DEFAULT 0,
          user_agent VARCHAR(500),
          impersonator_id UUID,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
        CREATE INDEX IF NOT EXISTS usage_session_user_started_idx ON %1$I.usage_session (user_id, started_at);

        CREATE TABLE IF NOT EXISTS %1$I.usage_heartbeat (
          id BIGSERIAL PRIMARY KEY,
          session_id UUID NOT NULL,
          user_id UUID NOT NULL,
          at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
        CREATE INDEX IF NOT EXISTS usage_heartbeat_user_at_idx ON %1$I.usage_heartbeat (user_id, at);
        CREATE INDEX IF NOT EXISTS usage_heartbeat_session_idx ON %1$I.usage_heartbeat (session_id);

        CREATE TABLE IF NOT EXISTS %1$I.usage_view_event (
          id BIGSERIAL PRIMARY KEY,
          user_id UUID NOT NULL,
          session_id UUID NOT NULL,
          at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          entity_type TEXT NOT NULL,
          entity_id UUID,
          route TEXT NOT NULL,
          label_snapshot TEXT
        );
        CREATE INDEX IF NOT EXISTS usage_view_event_user_at_idx ON %1$I.usage_view_event (user_id, at);

        CREATE TABLE IF NOT EXISTS %1$I.usage_daily (
          user_id UUID NOT NULL,
          date DATE NOT NULL,
          active_seconds INTEGER NOT NULL DEFAULT 0,
          session_count INTEGER NOT NULL DEFAULT 0,
          view_count INTEGER NOT NULL DEFAULT 0,
          action_count INTEGER NOT NULL DEFAULT 0,
          breakdown JSONB NOT NULL,
          first_active_at TIMESTAMPTZ,
          last_active_at TIMESTAMPTZ,
          rolled_up_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          PRIMARY KEY (user_id, date)
        );
      $sql$,
      schema_name
    );
  END LOOP;
END $tenant$;

-- New tenants: the office provisioner clones this marked block (office_dallas -> new schema).
-- TENANT_SCHEMA_START
CREATE TABLE IF NOT EXISTS office_dallas.usage_session (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL,
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_heartbeat_at TIMESTAMPTZ,
  ended_at TIMESTAMPTZ,
  active_seconds INTEGER NOT NULL DEFAULT 0,
  user_agent VARCHAR(500),
  impersonator_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS usage_session_user_started_idx ON office_dallas.usage_session (user_id, started_at);

CREATE TABLE IF NOT EXISTS office_dallas.usage_heartbeat (
  id BIGSERIAL PRIMARY KEY,
  session_id UUID NOT NULL,
  user_id UUID NOT NULL,
  at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS usage_heartbeat_user_at_idx ON office_dallas.usage_heartbeat (user_id, at);
CREATE INDEX IF NOT EXISTS usage_heartbeat_session_idx ON office_dallas.usage_heartbeat (session_id);

CREATE TABLE IF NOT EXISTS office_dallas.usage_view_event (
  id BIGSERIAL PRIMARY KEY,
  user_id UUID NOT NULL,
  session_id UUID NOT NULL,
  at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  entity_type TEXT NOT NULL,
  entity_id UUID,
  route TEXT NOT NULL,
  label_snapshot TEXT
);
CREATE INDEX IF NOT EXISTS usage_view_event_user_at_idx ON office_dallas.usage_view_event (user_id, at);

CREATE TABLE IF NOT EXISTS office_dallas.usage_daily (
  user_id UUID NOT NULL,
  date DATE NOT NULL,
  active_seconds INTEGER NOT NULL DEFAULT 0,
  session_count INTEGER NOT NULL DEFAULT 0,
  view_count INTEGER NOT NULL DEFAULT 0,
  action_count INTEGER NOT NULL DEFAULT 0,
  breakdown JSONB NOT NULL,
  first_active_at TIMESTAMPTZ,
  last_active_at TIMESTAMPTZ,
  rolled_up_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, date)
);
-- TENANT_SCHEMA_END
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run server/tests/scripts/usage-migration.runtime.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add migrations/0157_usage_tracking.sql server/tests/scripts/usage-migration.runtime.test.ts
git commit -m "feat(usage): migration 0157 — usage tables per office schema"
```

---

## Task 3: Pinned constants + shared types

**Files:**
- Create: `server/src/modules/usage/constants.ts`
- Create: `server/src/modules/usage/types.ts`
- Test: `server/src/modules/usage/constants.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// server/src/modules/usage/constants.test.ts
import { describe, expect, it } from "vitest";
import { HEARTBEAT_INTERVAL_S, HEARTBEAT_GRACE_S } from "./constants.js";

describe("usage constants", () => {
  it("pins the heartbeat cadence deterministically", () => {
    expect(HEARTBEAT_INTERVAL_S).toBe(30);
    expect(HEARTBEAT_GRACE_S).toBe(5);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run server/src/modules/usage/constants.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write constants and types**

```ts
// server/src/modules/usage/constants.ts
/** Heartbeat cadence, in seconds. The client sends one heartbeat per interval while active. */
export const HEARTBEAT_INTERVAL_S = 30;
/** Merge tolerance, in seconds. Consecutive active windows within this gap are treated contiguous. */
export const HEARTBEAT_GRACE_S = 5;
/** Raw heartbeat/view rows are kept this many days before the gated prune removes them. */
export const RAW_RETENTION_DAYS = 14;
```

```ts
// server/src/modules/usage/types.ts

/** A single browser session row (one per tab/app load). */
export interface RawSession {
  id: string;
  impersonatorId: string | null;
}

/** A server-stamped heartbeat. */
export interface RawHeartbeat {
  sessionId: string;
  at: Date;
}

/** A server-stamped view/navigation event. */
export interface RawViewEvent {
  sessionId: string;
  at: Date;
  entityType: "deal" | "lead" | "report" | "page" | string;
}

/** An auditLog row used for creates/edits (carries impersonator_id). */
export interface RawAuditRow {
  action: "insert" | "update" | "delete" | "soft_delete" | string;
  tableName: string;
  createdAt: Date;
  impersonatorId: string | null;
}

/** A deal_stage_history row (no impersonator column — see spec §8 caveat). */
export interface RawStageMove {
  createdAt: Date;
}

/** An activities row (no impersonator column). */
export interface RawActivity {
  type: string; // ACTIVITY_TYPES member: note/call/meeting/email/site_visit/follow_up/...
  at: Date;
}

/** A files/photo_tags upload row (no impersonator column). */
export interface RawUpload {
  at: Date;
}

/** Everything computeUsageDaily needs for one (user, date). */
export interface UsageRawInput {
  userId: string;
  date: string; // YYYY-MM-DD (the local calendar day this fold represents)
  sessions: RawSession[];
  heartbeats: RawHeartbeat[];
  viewEvents: RawViewEvent[];
  auditRows: RawAuditRow[];
  stageMoves: RawStageMove[];
  activities: RawActivity[];
  uploads: RawUpload[];
}

/** The breakdown JSONB shape stored on usage_daily. */
export interface UsageBreakdown {
  deal_views: number;
  lead_views: number;
  report_views: number;
  page_views: number;
  creates: number;
  edits: number;
  stage_moves: number;
  uploads: number;
  activities: Record<string, number>; // sub-keyed by activity type
}

/** The per-(user,date) output. Persisted verbatim to usage_daily by the rollup. */
export interface UsageDailyShape {
  userId: string;
  date: string;
  activeSeconds: number;
  sessionCount: number;
  viewCount: number;
  actionCount: number;
  breakdown: UsageBreakdown;
  firstActiveAt: string | null; // ISO string or null
  lastActiveAt: string | null;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run server/src/modules/usage/constants.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/modules/usage/constants.ts server/src/modules/usage/types.ts server/src/modules/usage/constants.test.ts
git commit -m "feat(usage): pinned constants + raw-input/output types"
```

---

## Task 4: Interval-merge (pure active-time accrual)

**Files:**
- Create: `server/src/modules/usage/interval-merge.ts`
- Test: `server/src/modules/usage/interval-merge.test.ts`

Approach: each non-impersonated heartbeat at time `t` produces an active window `[t − HEARTBEAT_INTERVAL_S, t]`. All windows across the user's sessions are merged (two windows merge when the gap between them is `≤ HEARTBEAT_GRACE_S`). `activeSeconds` = sum of merged window lengths. This caps idle gaps (a gap `> INTERVAL+GRACE` leaves windows unmerged, so idle time is never credited) and dedups multiple tabs (overlapping windows merge to one).

- [ ] **Step 1: Write the failing test**

```ts
// server/src/modules/usage/interval-merge.test.ts
import { describe, expect, it } from "vitest";
import { mergeActiveSeconds } from "./interval-merge.js";

const t = (sec: number) => new Date(Date.UTC(2026, 5, 9, 12, 0, sec));

describe("mergeActiveSeconds", () => {
  it("credits one interval for a single heartbeat", () => {
    expect(mergeActiveSeconds([t(30)])).toBe(30);
  });

  it("treats two heartbeats one interval apart as contiguous (no double count)", () => {
    // windows [0,30] and [30,60] -> merged 60s
    expect(mergeActiveSeconds([t(30), t(60)])).toBe(60);
  });

  it("merges across small jitter within the grace window", () => {
    // windows [0,30] and [33,63], gap 3 <= grace 5 -> merged [0,63] = 63s
    expect(mergeActiveSeconds([t(30), t(63)])).toBe(63);
  });

  it("does NOT credit idle gaps beyond interval+grace", () => {
    // heartbeat at 30 then at 600: windows [0,30] and [570,600] -> 60s total, idle excluded
    expect(mergeActiveSeconds([t(30), t(600)])).toBe(60);
  });

  it("dedups overlapping windows from two tabs", () => {
    // two sessions heartbeating at the same instants -> counted once
    expect(mergeActiveSeconds([t(30), t(30), t(60), t(60)])).toBe(60);
  });

  it("returns 0 for no heartbeats", () => {
    expect(mergeActiveSeconds([])).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run server/src/modules/usage/interval-merge.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the merge**

```ts
// server/src/modules/usage/interval-merge.ts
import { HEARTBEAT_INTERVAL_S, HEARTBEAT_GRACE_S } from "./constants.js";

/**
 * Compute active seconds from heartbeat timestamps (already filtered to non-impersonated
 * sessions). Each heartbeat at time t covers the window [t - HEARTBEAT_INTERVAL_S, t]; windows
 * separated by <= HEARTBEAT_GRACE_S are merged. Idle gaps larger than that are never credited,
 * and overlapping windows from multiple tabs are counted once.
 */
export function mergeActiveSeconds(heartbeatTimes: Date[]): number {
  if (heartbeatTimes.length === 0) return 0;

  const windows = heartbeatTimes
    .map((d) => {
      const end = Math.floor(d.getTime() / 1000);
      return { start: end - HEARTBEAT_INTERVAL_S, end };
    })
    .sort((a, b) => a.start - b.start);

  let total = 0;
  let curStart = windows[0].start;
  let curEnd = windows[0].end;

  for (let i = 1; i < windows.length; i++) {
    const w = windows[i];
    if (w.start - curEnd <= HEARTBEAT_GRACE_S) {
      // contiguous (or overlapping) — extend
      if (w.end > curEnd) curEnd = w.end;
    } else {
      total += curEnd - curStart;
      curStart = w.start;
      curEnd = w.end;
    }
  }
  total += curEnd - curStart;
  return total;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run server/src/modules/usage/interval-merge.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add server/src/modules/usage/interval-merge.ts server/src/modules/usage/interval-merge.test.ts
git commit -m "feat(usage): interval-merge for active-time accrual (idle cap + multi-tab dedup)"
```

---

## Task 5: Multi-source action registry + per-source contract test

**Files:**
- Create: `server/src/modules/usage/action-sources.ts`
- Test: `server/src/modules/usage/action-sources.test.ts`

The registry is the single source of truth mapping breakdown keys to their backing table + selector. The contract test asserts each named table/column/enum value is real (per spec §5).

- [ ] **Step 1: Write the failing test**

```ts
// server/src/modules/usage/action-sources.test.ts
import { describe, expect, it } from "vitest";
import { USAGE_ACTION_SOURCES } from "./action-sources.js";
import { AUDIT_ACTIONS, ACTIVITY_TYPES } from "@trock-crm/shared/types";

describe("USAGE_ACTION_SOURCES registry contract", () => {
  it("auditLog-backed keys reference real audit actions", () => {
    expect(AUDIT_ACTIONS).toContain(USAGE_ACTION_SOURCES.creates.auditAction);
    expect(AUDIT_ACTIONS).toContain(USAGE_ACTION_SOURCES.edits.auditAction);
  });

  it("only creates/edits are auditLog-sourced (carry impersonator exclusion)", () => {
    const auditKeys = Object.entries(USAGE_ACTION_SOURCES)
      .filter(([, s]) => s.table === "audit_log")
      .map(([k]) => k)
      .sort();
    expect(auditKeys).toEqual(["creates", "edits"]);
  });

  it("declares the non-audit sources with no impersonator exclusion", () => {
    expect(USAGE_ACTION_SOURCES.stage_moves.table).toBe("deal_stage_history");
    expect(USAGE_ACTION_SOURCES.stage_moves.impersonationExcluded).toBe(false);
    expect(USAGE_ACTION_SOURCES.uploads.table).toBe("files");
    expect(USAGE_ACTION_SOURCES.activities.table).toBe("activities");
  });

  it("activity sub-keys are all real ACTIVITY_TYPES", () => {
    for (const t of USAGE_ACTION_SOURCES.activities.types) {
      expect(ACTIVITY_TYPES).toContain(t);
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run server/src/modules/usage/action-sources.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the registry**

```ts
// server/src/modules/usage/action-sources.ts
import { ACTIVITY_TYPES, type ActivityType } from "@trock-crm/shared/types";

/**
 * Single source of truth: which backing table + selector feeds each action breakdown key.
 * Verified by action-sources.test.ts against the real schema enums. Only audit_log carries
 * impersonator_id, so only creates/edits can exclude impersonated writes (spec §8 caveat).
 */
export const USAGE_ACTION_SOURCES = {
  creates: { table: "audit_log", auditAction: "insert", impersonationExcluded: true },
  edits: { table: "audit_log", auditAction: "update", impersonationExcluded: true },
  stage_moves: { table: "deal_stage_history", impersonationExcluded: false },
  uploads: { table: "files", impersonationExcluded: false },
  activities: {
    table: "activities",
    impersonationExcluded: false,
    types: ACTIVITY_TYPES as readonly ActivityType[],
  },
} as const;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run server/src/modules/usage/action-sources.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add server/src/modules/usage/action-sources.ts server/src/modules/usage/action-sources.test.ts
git commit -m "feat(usage): multi-source action registry + per-source contract test"
```

---

## Task 6: `computeUsageDaily` — the pure aggregation spine

**Files:**
- Create: `server/src/modules/usage/aggregate.ts`
- Test: `server/src/modules/usage/aggregate.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// server/src/modules/usage/aggregate.test.ts
import { describe, expect, it } from "vitest";
import { computeUsageDaily } from "./aggregate.js";
import type { UsageRawInput } from "./types.js";

const t = (sec: number) => new Date(Date.UTC(2026, 5, 9, 12, 0, sec));

function baseInput(overrides: Partial<UsageRawInput> = {}): UsageRawInput {
  return {
    userId: "rep-1",
    date: "2026-06-09",
    sessions: [{ id: "s1", impersonatorId: null }],
    heartbeats: [],
    viewEvents: [],
    auditRows: [],
    stageMoves: [],
    activities: [],
    uploads: [],
    ...overrides,
  };
}

describe("computeUsageDaily", () => {
  it("returns an all-zero shape for an empty day", () => {
    const out = computeUsageDaily(baseInput({ sessions: [] }));
    expect(out).toEqual({
      userId: "rep-1",
      date: "2026-06-09",
      activeSeconds: 0,
      sessionCount: 0,
      viewCount: 0,
      actionCount: 0,
      breakdown: {
        deal_views: 0, lead_views: 0, report_views: 0, page_views: 0,
        creates: 0, edits: 0, stage_moves: 0, uploads: 0, activities: {},
      },
      firstActiveAt: null,
      lastActiveAt: null,
    });
  });

  it("counts sessions started, views by type, and active time", () => {
    const out = computeUsageDaily(baseInput({
      sessions: [{ id: "s1", impersonatorId: null }, { id: "s2", impersonatorId: null }],
      heartbeats: [{ sessionId: "s1", at: t(30) }, { sessionId: "s1", at: t(60) }],
      viewEvents: [
        { sessionId: "s1", at: t(31), entityType: "deal" },
        { sessionId: "s1", at: t(32), entityType: "deal" },
        { sessionId: "s1", at: t(33), entityType: "lead" },
        { sessionId: "s1", at: t(34), entityType: "report" },
        { sessionId: "s1", at: t(35), entityType: "page" },
      ],
    }));
    expect(out.sessionCount).toBe(2);
    expect(out.activeSeconds).toBe(60);
    expect(out.viewCount).toBe(5);
    expect(out.breakdown.deal_views).toBe(2);
    expect(out.breakdown.lead_views).toBe(1);
    expect(out.breakdown.report_views).toBe(1);
    expect(out.breakdown.page_views).toBe(1);
    expect(out.firstActiveAt).toBe(t(30).toISOString());
    expect(out.lastActiveAt).toBe(t(60).toISOString());
  });

  it("counts actions from all four sources and sums action_count", () => {
    const out = computeUsageDaily(baseInput({
      auditRows: [
        { action: "insert", tableName: "deals", createdAt: t(10), impersonatorId: null },
        { action: "update", tableName: "deals", createdAt: t(20), impersonatorId: null },
        { action: "update", tableName: "leads", createdAt: t(21), impersonatorId: null },
      ],
      stageMoves: [{ createdAt: t(40) }, { createdAt: t(41) }],
      uploads: [{ at: t(50) }],
      activities: [{ type: "note", at: t(60) }, { type: "call", at: t(61) }, { type: "note", at: t(62) }],
    }));
    expect(out.breakdown.creates).toBe(1);
    expect(out.breakdown.edits).toBe(2);
    expect(out.breakdown.stage_moves).toBe(2);
    expect(out.breakdown.uploads).toBe(1);
    expect(out.breakdown.activities).toEqual({ note: 2, call: 1 });
    // 1 + 2 + 2 + 1 + (2+1) = 9
    expect(out.actionCount).toBe(9);
  });

  it("excludes impersonated sessions from time and views, and impersonated audit rows from creates/edits", () => {
    const out = computeUsageDaily(baseInput({
      sessions: [
        { id: "s1", impersonatorId: null },
        { id: "imp", impersonatorId: "admin-9" },
      ],
      heartbeats: [
        { sessionId: "s1", at: t(30) },
        { sessionId: "imp", at: t(300) }, // impersonated — must not accrue time
      ],
      viewEvents: [
        { sessionId: "s1", at: t(31), entityType: "deal" },
        { sessionId: "imp", at: t(301), entityType: "deal" }, // impersonated — excluded
      ],
      auditRows: [
        { action: "insert", tableName: "deals", createdAt: t(10), impersonatorId: null },
        { action: "insert", tableName: "deals", createdAt: t(11), impersonatorId: "admin-9" }, // excluded
      ],
      stageMoves: [{ createdAt: t(40) }], // NOT excludable (no impersonator col) — still counted
    }));
    expect(out.activeSeconds).toBe(30); // only s1
    expect(out.viewCount).toBe(1);
    expect(out.breakdown.creates).toBe(1); // impersonated insert excluded
    expect(out.breakdown.stage_moves).toBe(1); // documented caveat: not excluded
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run server/src/modules/usage/aggregate.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `computeUsageDaily`**

```ts
// server/src/modules/usage/aggregate.ts
import { mergeActiveSeconds } from "./interval-merge.js";
import { USAGE_ACTION_SOURCES } from "./action-sources.js";
import type { UsageRawInput, UsageDailyShape, UsageBreakdown } from "./types.js";

/**
 * Pure: fold one (user, date)'s raw rows into the usage_daily shape. Both the live "today"
 * read path and the nightly rollup call this, so a completed day reconciles byte-for-byte
 * (spec §5 invariant). No I/O.
 */
export function computeUsageDaily(input: UsageRawInput): UsageDailyShape {
  // --- impersonation exclusion: time + views are scoped to non-impersonated sessions ---
  const realSessionIds = new Set(
    input.sessions.filter((s) => s.impersonatorId === null).map((s) => s.id),
  );

  const realHeartbeats = input.heartbeats.filter((h) => realSessionIds.has(h.sessionId));
  const activeSeconds = mergeActiveSeconds(realHeartbeats.map((h) => h.at));

  const heartbeatTimes = realHeartbeats.map((h) => h.at.getTime());
  const firstActiveAt = heartbeatTimes.length
    ? new Date(Math.min(...heartbeatTimes)).toISOString()
    : null;
  const lastActiveAt = heartbeatTimes.length
    ? new Date(Math.max(...heartbeatTimes)).toISOString()
    : null;

  const realViews = input.viewEvents.filter((v) => realSessionIds.has(v.sessionId));
  const breakdown: UsageBreakdown = {
    deal_views: 0, lead_views: 0, report_views: 0, page_views: 0,
    creates: 0, edits: 0, stage_moves: 0, uploads: 0, activities: {},
  };
  for (const v of realViews) {
    if (v.entityType === "deal") breakdown.deal_views++;
    else if (v.entityType === "lead") breakdown.lead_views++;
    else if (v.entityType === "report") breakdown.report_views++;
    else breakdown.page_views++;
  }
  const viewCount = realViews.length;

  // --- actions: multi-source per USAGE_ACTION_SOURCES ---
  // creates/edits from auditLog (impersonation-excludable)
  for (const row of input.auditRows) {
    if (row.impersonatorId !== null) continue; // excluded (carries impersonator_id)
    if (row.action === USAGE_ACTION_SOURCES.creates.auditAction) breakdown.creates++;
    else if (row.action === USAGE_ACTION_SOURCES.edits.auditAction) breakdown.edits++;
  }
  // stage_moves / uploads / activities — no impersonator column (documented caveat)
  breakdown.stage_moves = input.stageMoves.length;
  breakdown.uploads = input.uploads.length;
  for (const a of input.activities) {
    breakdown.activities[a.type] = (breakdown.activities[a.type] ?? 0) + 1;
  }

  const activitiesTotal = Object.values(breakdown.activities).reduce((s, n) => s + n, 0);
  const actionCount =
    breakdown.creates + breakdown.edits + breakdown.stage_moves + breakdown.uploads + activitiesTotal;

  return {
    userId: input.userId,
    date: input.date,
    activeSeconds,
    sessionCount: input.sessions.length, // "sessions started" — see spec §3
    viewCount,
    actionCount,
    breakdown,
    firstActiveAt,
    lastActiveAt,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run server/src/modules/usage/aggregate.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add server/src/modules/usage/aggregate.ts server/src/modules/usage/aggregate.test.ts
git commit -m "feat(usage): computeUsageDaily pure aggregation spine"
```

---

## Task 7: Byte-identical invariant test (closed-day fixture)

**Files:**
- Test: `server/src/modules/usage/byte-identical.test.ts`

Per spec §5 + self-review: the invariant is "given the same raw rows for a **completed** day, the live path and the rollup path produce byte-identical output." Because both callers funnel through `computeUsageDaily`, this test guards that neither caller mutates/normalizes the raw input differently. We simulate both callers around a frozen (closed-day) fixture.

- [ ] **Step 1: Write the test**

```ts
// server/src/modules/usage/byte-identical.test.ts
import { describe, expect, it } from "vitest";
import { computeUsageDaily } from "./aggregate.js";
import type { UsageRawInput } from "./types.js";

// A frozen fixture representing a COMPLETED (closed) day — not a live snapshot.
const CLOSED_DAY: UsageRawInput = {
  userId: "rep-7",
  date: "2026-06-01",
  sessions: [{ id: "s1", impersonatorId: null }, { id: "s2", impersonatorId: null }],
  heartbeats: [
    { sessionId: "s1", at: new Date("2026-06-01T14:00:30Z") },
    { sessionId: "s1", at: new Date("2026-06-01T14:01:00Z") },
    { sessionId: "s2", at: new Date("2026-06-01T14:00:45Z") },
  ],
  viewEvents: [
    { sessionId: "s1", at: new Date("2026-06-01T14:00:31Z"), entityType: "deal" },
    { sessionId: "s2", at: new Date("2026-06-01T14:00:46Z"), entityType: "report" },
  ],
  auditRows: [
    { action: "insert", tableName: "deals", createdAt: new Date("2026-06-01T13:00:00Z"), impersonatorId: null },
    { action: "update", tableName: "leads", createdAt: new Date("2026-06-01T13:05:00Z"), impersonatorId: null },
  ],
  stageMoves: [{ createdAt: new Date("2026-06-01T13:10:00Z") }],
  activities: [{ type: "note", at: new Date("2026-06-01T13:20:00Z") }],
  uploads: [{ at: new Date("2026-06-01T13:30:00Z") }],
};

// The two production callers both do exactly this: fetch raw rows for the day, call compute.
// (raw-fetch.ts returns this shape; read-service "today" and the rollup both consume it.)
function livePathCompute(raw: UsageRawInput) {
  return computeUsageDaily(raw);
}
function rollupPathCompute(raw: UsageRawInput) {
  return computeUsageDaily(raw);
}

describe("live vs rollup byte-identical invariant (closed-day fixture)", () => {
  it("produces identical output for the same completed-day raw rows", () => {
    const live = livePathCompute(CLOSED_DAY);
    const rollup = rollupPathCompute(CLOSED_DAY);
    expect(JSON.stringify(live)).toBe(JSON.stringify(rollup));
  });
});
```

> **Implementation note for the engineer:** when Task 12/13/15 land, refactor `livePathCompute`/`rollupPathCompute` here to import the *actual* caller wrappers (`buildLiveDay` from `read-service.ts` and the rollup's fold step) so the test guards the real callers, not local stand-ins. Keep the frozen `CLOSED_DAY` fixture.

- [ ] **Step 2: Run test to verify it passes**

Run: `npx vitest run server/src/modules/usage/byte-identical.test.ts`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add server/src/modules/usage/byte-identical.test.ts
git commit -m "test(usage): byte-identical live-vs-rollup invariant (closed-day fixture)"
```

---

## Task 8: Usage module router scaffold + registration

**Files:**
- Create: `server/src/modules/usage/routes.ts`
- Modify: `server/src/route-access-policy.ts`
- Modify: `server/src/app.ts`
- Test: `server/tests/usage-route-registration.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// server/tests/usage-route-registration.test.ts
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

describe("usage route registration", () => {
  it("mounts /usage in the CRM tenant route policy", () => {
    const policy = readFileSync(new URL("../src/route-access-policy.ts", import.meta.url), "utf8");
    expect(policy).toContain('"/usage"');
  });

  it("wires usageRoutes into app.ts", () => {
    const app = readFileSync(new URL("../src/app.ts", import.meta.url), "utf8");
    expect(app).toContain("usageRoutes");
    expect(app).toContain('["/usage", usageRoutes]');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run server/tests/usage-route-registration.test.ts`
Expected: FAIL — strings absent.

- [ ] **Step 3: Create the router stub**

```ts
// server/src/modules/usage/routes.ts
import { Router } from "express";

const router = Router();

// Endpoints are added in Tasks 9–11.

export default router;
```

- [ ] **Step 4: Register the mount**

In `server/src/route-access-policy.ts`, add `"/usage",` to the `CRM_ONLY_TENANT_ROUTE_MOUNTS` array (place it after `"/activities"`).

In `server/src/app.ts`:
- Add the import near the other module route imports: `import usageRoutes from "./modules/usage/routes.js";`
- Add the tuple to the `crmOnlyTenantRoutes` array: `["/usage", usageRoutes],`

- [ ] **Step 5: Run test + typecheck**

Run: `npx vitest run server/tests/usage-route-registration.test.ts`
Expected: PASS.
Run: `npm run typecheck --workspace=server`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add server/src/modules/usage/routes.ts server/src/route-access-policy.ts server/src/app.ts server/tests/usage-route-registration.test.ts
git commit -m "feat(usage): scaffold /api/usage router + registration"
```

---

## Task 9: `POST /api/usage/session/start`

**Files:**
- Create: `server/src/modules/usage/collection-service.ts`
- Modify: `server/src/modules/usage/routes.ts`
- Test: `server/src/modules/usage/collection-service.test.ts`

The service inserts a `usage_session` row, stamping `impersonator_id` from request context when present. Determining impersonation: the audit logger reads an impersonator id from context; reuse the same source. Look for how `impersonatorId` is resolved in an existing route that calls `buildAuditActorFromUser` (e.g. `server/src/modules/leads/routes.ts:72`) and read it from `req` the same way (commonly `req.impersonatorId ?? null`). If no such field exists on `req`, pass `null` and add a `TODO(usage): wire impersonator context` — but first grep `req.impersonator` in `server/src` to confirm the field name.

- [ ] **Step 1: Write the failing test**

```ts
// server/src/modules/usage/collection-service.test.ts
import { describe, expect, it, vi } from "vitest";
import { startSession } from "./collection-service.js";

function tenantDbCapturingInsert() {
  const inserted: unknown[] = [];
  const chain = {
    values: vi.fn().mockImplementation((v: unknown) => {
      inserted.push(v);
      return { returning: vi.fn().mockResolvedValue([{ id: "new-session-id" }]) };
    }),
  };
  return {
    db: { insert: vi.fn().mockReturnValue(chain) } as any,
    inserted,
  };
}

describe("startSession", () => {
  it("inserts a session for the user with the user agent and impersonator stamp", async () => {
    const { db, inserted } = tenantDbCapturingInsert();
    const result = await startSession(db, {
      userId: "rep-1",
      userAgent: "Mozilla/5.0",
      impersonatorId: "admin-9",
    });
    expect(result).toEqual({ sessionId: "new-session-id" });
    expect(inserted[0]).toMatchObject({
      userId: "rep-1",
      userAgent: "Mozilla/5.0",
      impersonatorId: "admin-9",
    });
  });

  it("stamps null impersonator for a normal session", async () => {
    const { db, inserted } = tenantDbCapturingInsert();
    await startSession(db, { userId: "rep-1", userAgent: "UA", impersonatorId: null });
    expect(inserted[0]).toMatchObject({ impersonatorId: null });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run server/src/modules/usage/collection-service.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the service**

```ts
// server/src/modules/usage/collection-service.ts
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type * as schema from "@trock-crm/shared/schema";
import { usageSession, usageHeartbeat, usageViewEvent } from "@trock-crm/shared/schema";

type TenantDb = NodePgDatabase<typeof schema>;

export interface StartSessionInput {
  userId: string;
  userAgent: string | null;
  impersonatorId: string | null;
}

export async function startSession(
  tenantDb: Pick<TenantDb, "insert">,
  input: StartSessionInput,
): Promise<{ sessionId: string }> {
  const [row] = await tenantDb
    .insert(usageSession)
    .values({
      userId: input.userId,
      userAgent: input.userAgent ?? null,
      impersonatorId: input.impersonatorId,
    })
    .returning({ id: usageSession.id });
  return { sessionId: row.id };
}

export interface HeartbeatInput {
  userId: string;
  sessionId: string;
}

/** Server-stamped: `at` and `last_heartbeat_at` use the DB default / now(); client time is ignored. */
export async function recordHeartbeat(
  tenantDb: Pick<TenantDb, "insert" | "update">,
  input: HeartbeatInput,
): Promise<void> {
  await tenantDb.insert(usageHeartbeat).values({ userId: input.userId, sessionId: input.sessionId });
  await tenantDb
    .update(usageSession)
    .set({ lastHeartbeatAt: new Date() })
    .where(eqSessionForUser(input.sessionId, input.userId));
}

export interface ViewEventInput {
  entityType: string;
  entityId: string | null;
  route: string;
  labelSnapshot: string | null;
}

export async function recordViewEvents(
  tenantDb: Pick<TenantDb, "insert">,
  userId: string,
  sessionId: string,
  events: ViewEventInput[],
): Promise<void> {
  if (events.length === 0) return;
  await tenantDb.insert(usageViewEvent).values(
    events.map((e) => ({
      userId,
      sessionId,
      entityType: e.entityType,
      entityId: e.entityId,
      route: e.route,
      labelSnapshot: e.labelSnapshot,
    })),
  );
}

import { and, eq } from "drizzle-orm";
function eqSessionForUser(sessionId: string, userId: string) {
  return and(eq(usageSession.id, sessionId), eq(usageSession.userId, userId));
}
```

- [ ] **Step 4: Add the route handler**

In `server/src/modules/usage/routes.ts`:

```ts
import { Router } from "express";
import { startSession } from "./collection-service.js";

const router = Router();

router.post("/session/start", async (req, res, next) => {
  try {
    const result = await startSession(req.tenantDb!, {
      userId: req.user!.id,
      userAgent: typeof req.headers["user-agent"] === "string" ? req.headers["user-agent"].slice(0, 500) : null,
      impersonatorId: (req as { impersonatorId?: string | null }).impersonatorId ?? null,
    });
    await req.commitTransaction!();
    res.json(result);
  } catch (err) {
    next(err);
  }
});

export default router;
```

> Before finalizing, grep `req.impersonatorId` / `impersonator` in `server/src/middleware` and `server/src/modules/leads/routes.ts` to confirm the exact field that carries the impersonator id on the request, and use that here.

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run server/src/modules/usage/collection-service.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 6: Commit**

```bash
git add server/src/modules/usage/collection-service.ts server/src/modules/usage/routes.ts server/src/modules/usage/collection-service.test.ts
git commit -m "feat(usage): POST /usage/session/start with impersonator stamp"
```

---

## Task 10: `POST /api/usage/heartbeat`

**Files:**
- Modify: `server/src/modules/usage/routes.ts`
- Test: `server/src/modules/usage/collection-service.test.ts` (extend)

`recordHeartbeat` was written in Task 9. This task wires the route + tests the insert/update.

- [ ] **Step 1: Add the failing test (extend the existing file)**

```ts
// append to server/src/modules/usage/collection-service.test.ts
import { recordHeartbeat } from "./collection-service.js";

describe("recordHeartbeat", () => {
  it("inserts a heartbeat row and updates the session last_heartbeat_at", async () => {
    const heartbeatInserts: unknown[] = [];
    const sessionUpdates: unknown[] = [];
    const db = {
      insert: vi.fn().mockReturnValue({
        values: vi.fn().mockImplementation((v: unknown) => { heartbeatInserts.push(v); return Promise.resolve(); }),
      }),
      update: vi.fn().mockReturnValue({
        set: vi.fn().mockImplementation((v: unknown) => { sessionUpdates.push(v); return { where: vi.fn().mockResolvedValue(undefined) }; }),
      }),
    } as any;

    await recordHeartbeat(db, { userId: "rep-1", sessionId: "s1" });

    expect(heartbeatInserts[0]).toMatchObject({ userId: "rep-1", sessionId: "s1" });
    expect((sessionUpdates[0] as { lastHeartbeatAt: Date }).lastHeartbeatAt).toBeInstanceOf(Date);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run server/src/modules/usage/collection-service.test.ts`
Expected: FAIL — `recordHeartbeat` exists, but if Task 9 already added it the test should pass logic; if it fails it's because the route isn't wired. (If the service test passes already, proceed to wire the route, then re-run.)

- [ ] **Step 3: Add the route handler**

In `server/src/modules/usage/routes.ts`, add:

```ts
import { recordHeartbeat } from "./collection-service.js";

router.post("/heartbeat", async (req, res, next) => {
  try {
    const sessionId = (req.body as { sessionId?: unknown }).sessionId;
    if (typeof sessionId !== "string") {
      res.status(400).json({ error: "sessionId required" });
      return;
    }
    await recordHeartbeat(req.tenantDb!, { userId: req.user!.id, sessionId });
    await req.commitTransaction!();
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run server/src/modules/usage/collection-service.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/modules/usage/routes.ts server/src/modules/usage/collection-service.test.ts
git commit -m "feat(usage): POST /usage/heartbeat (server-stamped)"
```

---

## Task 11: `POST /api/usage/events` (batched view events)

**Files:**
- Modify: `server/src/modules/usage/routes.ts`
- Test: `server/src/modules/usage/collection-service.test.ts` (extend)

`recordViewEvents` was written in Task 9. Wire + test batch insert and the empty-batch no-op.

- [ ] **Step 1: Add the failing test**

```ts
// append to server/src/modules/usage/collection-service.test.ts
import { recordViewEvents } from "./collection-service.js";

describe("recordViewEvents", () => {
  it("batch-inserts events with user + session attached", async () => {
    const inserts: unknown[] = [];
    const db = { insert: vi.fn().mockReturnValue({ values: vi.fn().mockImplementation((v: unknown) => { inserts.push(v); return Promise.resolve(); }) }) } as any;
    await recordViewEvents(db, "rep-1", "s1", [
      { entityType: "deal", entityId: "d-1", route: "/deals/d-1", labelSnapshot: "Tides" },
    ]);
    expect((inserts[0] as unknown[])[0]).toMatchObject({ userId: "rep-1", sessionId: "s1", entityType: "deal" });
  });

  it("no-ops on an empty batch", async () => {
    const db = { insert: vi.fn() } as any;
    await recordViewEvents(db, "rep-1", "s1", []);
    expect(db.insert).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails (then passes the service logic)**

Run: `npx vitest run server/src/modules/usage/collection-service.test.ts`
Expected: PASS for service logic (written in Task 9). Continue to wire the route.

- [ ] **Step 3: Add the route handler**

In `server/src/modules/usage/routes.ts`, add:

```ts
import { recordViewEvents, type ViewEventInput } from "./collection-service.js";

router.post("/events", async (req, res, next) => {
  try {
    const body = req.body as { sessionId?: unknown; events?: unknown };
    if (typeof body.sessionId !== "string" || !Array.isArray(body.events)) {
      res.status(400).json({ error: "sessionId and events[] required" });
      return;
    }
    const events: ViewEventInput[] = body.events.slice(0, 200).map((raw) => {
      const e = raw as Record<string, unknown>;
      return {
        entityType: typeof e.entityType === "string" ? e.entityType : "page",
        entityId: typeof e.entityId === "string" ? e.entityId : null,
        route: typeof e.route === "string" ? e.route : "",
        labelSnapshot: typeof e.labelSnapshot === "string" ? e.labelSnapshot : null,
      };
    });
    await recordViewEvents(req.tenantDb!, req.user!.id, body.sessionId, events);
    await req.commitTransaction!();
    res.json({ ok: true, accepted: events.length });
  } catch (err) {
    next(err);
  }
});
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run server/src/modules/usage/collection-service.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/modules/usage/routes.ts server/src/modules/usage/collection-service.test.ts
git commit -m "feat(usage): POST /usage/events (batched view events)"
```

---

## Task 12: `fetchRawUsageForDay` (DB → raw input)

**Files:**
- Create: `server/src/modules/usage/raw-fetch.ts`
- Test: `server/tests/scripts/usage-raw-fetch.runtime.test.ts` (PGlite)

This is the single fetch both the live read path and the rollup use. It runs raw SQL against the tenant schema (already on `search_path`) and returns a `UsageRawInput` for one user+day. Use a `client.query` shape (like `companycam-autolink.runtime.test.ts`) so it works both under the request's pg client and the rollup script's client.

- [ ] **Step 1: Write the failing PGlite test**

```ts
// server/tests/scripts/usage-raw-fetch.runtime.test.ts
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fetchRawUsageForDay } from "../../src/modules/usage/raw-fetch.js";

const U = (s: string) => `00000000-0000-4000-8000-${s.padStart(12, "0")}`;
const REP = U("0001");
let db: PGlite;
const client = () => ({ query: (sql: string, params?: unknown[]) => db.query(sql, params as any[]) }) as any;

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    CREATE SCHEMA office_dallas;
    SET search_path TO office_dallas, public;
    CREATE TABLE office_dallas.usage_session (id uuid primary key default gen_random_uuid(), user_id uuid, started_at timestamptz, last_heartbeat_at timestamptz, ended_at timestamptz, active_seconds int default 0, user_agent text, impersonator_id uuid, created_at timestamptz default now());
    CREATE TABLE office_dallas.usage_heartbeat (id bigserial primary key, session_id uuid, user_id uuid, at timestamptz);
    CREATE TABLE office_dallas.usage_view_event (id bigserial primary key, user_id uuid, session_id uuid, at timestamptz, entity_type text, entity_id uuid, route text, label_snapshot text);
    CREATE TABLE office_dallas.audit_log (id bigserial primary key, table_name text, action text, changed_by uuid, impersonator_id uuid, created_at timestamptz);
    CREATE TABLE office_dallas.deal_stage_history (id uuid primary key default gen_random_uuid(), deal_id uuid, to_stage_id uuid, changed_by uuid, created_at timestamptz);
    CREATE TABLE office_dallas.activities (id uuid primary key default gen_random_uuid(), type text, responsible_user_id uuid, occurred_at timestamptz, created_at timestamptz);
    CREATE TABLE office_dallas.files (id uuid primary key default gen_random_uuid(), uploaded_by uuid, created_at timestamptz);
  `);
  const s1 = U("00a1");
  await db.exec(`
    INSERT INTO office_dallas.usage_session (id, user_id, impersonator_id) VALUES ('${s1}', '${REP}', NULL);
    INSERT INTO office_dallas.usage_heartbeat (session_id, user_id, at) VALUES ('${s1}', '${REP}', '2026-06-01T14:00:30Z');
    INSERT INTO office_dallas.usage_view_event (user_id, session_id, at, entity_type, route) VALUES ('${REP}', '${s1}', '2026-06-01T14:00:31Z', 'deal', '/deals/x');
    INSERT INTO office_dallas.audit_log (table_name, action, changed_by, impersonator_id, created_at) VALUES ('deals', 'insert', '${REP}', NULL, '2026-06-01T13:00:00Z');
    INSERT INTO office_dallas.deal_stage_history (deal_id, to_stage_id, changed_by, created_at) VALUES ('${U("0dd1")}', '${U("0501")}', '${REP}', '2026-06-01T13:10:00Z');
    INSERT INTO office_dallas.activities (type, responsible_user_id, occurred_at, created_at) VALUES ('note', '${REP}', '2026-06-01T13:20:00Z', '2026-06-01T13:20:00Z');
    INSERT INTO office_dallas.files (uploaded_by, created_at) VALUES ('${REP}', '2026-06-01T13:30:00Z');
  `);
});

afterAll(async () => { await db?.close(); });

describe("fetchRawUsageForDay", () => {
  it("returns all raw rows for the user+day across the six sources", async () => {
    const raw = await fetchRawUsageForDay(client(), "office_dallas", REP, "2026-06-01");
    expect(raw.sessions).toHaveLength(1);
    expect(raw.heartbeats).toHaveLength(1);
    expect(raw.viewEvents).toHaveLength(1);
    expect(raw.auditRows).toHaveLength(1);
    expect(raw.stageMoves).toHaveLength(1);
    expect(raw.activities).toHaveLength(1);
    expect(raw.uploads).toHaveLength(1);
  });

  it("excludes rows from other days", async () => {
    const raw = await fetchRawUsageForDay(client(), "office_dallas", REP, "2026-06-02");
    expect(raw.heartbeats).toHaveLength(0);
    expect(raw.auditRows).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run server/tests/scripts/usage-raw-fetch.runtime.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `fetchRawUsageForDay`**

```ts
// server/src/modules/usage/raw-fetch.ts
import type { UsageRawInput } from "./types.js";

/** A minimal pg-like client (works for both the request client and the rollup script client). */
export interface QueryClient {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
}

/**
 * Fetch one user+day's raw rows from a single tenant schema. Day bounds are [date, date+1) on the
 * relevant timestamp column. `schema` is a validated office_* identifier. Used by BOTH the live
 * read path and the nightly rollup.
 */
export async function fetchRawUsageForDay(
  client: QueryClient,
  schema: string,
  userId: string,
  date: string, // YYYY-MM-DD
): Promise<UsageRawInput> {
  if (!/^office_[a-z0-9_]+$/.test(schema)) throw new Error(`invalid schema: ${schema}`);
  const s = schema;
  const dayStart = `${date}T00:00:00Z`;
  const range = `$2::timestamptz AND ${"$2::timestamptz + interval '1 day'"}`;

  const sessions = (await client.query<{ id: string; impersonator_id: string | null }>(
    `SELECT id, impersonator_id FROM ${s}.usage_session
       WHERE user_id = $1 AND started_at >= ${range}`,
    [userId, dayStart],
  )).rows;

  const heartbeats = (await client.query<{ session_id: string; at: string }>(
    `SELECT session_id, at FROM ${s}.usage_heartbeat
       WHERE user_id = $1 AND at >= ${range} ORDER BY at`,
    [userId, dayStart],
  )).rows;

  const viewEvents = (await client.query<{ session_id: string; at: string; entity_type: string }>(
    `SELECT session_id, at, entity_type FROM ${s}.usage_view_event
       WHERE user_id = $1 AND at >= ${range}`,
    [userId, dayStart],
  )).rows;

  const auditRows = (await client.query<{ action: string; table_name: string; created_at: string; impersonator_id: string | null }>(
    `SELECT action, table_name, created_at, impersonator_id FROM ${s}.audit_log
       WHERE changed_by = $1 AND created_at >= ${range}`,
    [userId, dayStart],
  )).rows;

  const stageMoves = (await client.query<{ created_at: string }>(
    `SELECT created_at FROM ${s}.deal_stage_history
       WHERE changed_by = $1 AND created_at >= ${range}`,
    [userId, dayStart],
  )).rows;

  const activities = (await client.query<{ type: string; at: string }>(
    `SELECT type, COALESCE(occurred_at, created_at) AS at FROM ${s}.activities
       WHERE responsible_user_id = $1 AND COALESCE(occurred_at, created_at) >= ${range}`,
    [userId, dayStart],
  )).rows;

  const uploads = (await client.query<{ at: string }>(
    `SELECT created_at AS at FROM ${s}.files
       WHERE uploaded_by = $1 AND created_at >= ${range}`,
    [userId, dayStart],
  )).rows;

  return {
    userId,
    date,
    sessions: sessions.map((r) => ({ id: r.id, impersonatorId: r.impersonator_id })),
    heartbeats: heartbeats.map((r) => ({ sessionId: r.session_id, at: new Date(r.at) })),
    viewEvents: viewEvents.map((r) => ({ sessionId: r.session_id, at: new Date(r.at), entityType: r.entity_type })),
    auditRows: auditRows.map((r) => ({ action: r.action, tableName: r.table_name, createdAt: new Date(r.created_at), impersonatorId: r.impersonator_id })),
    stageMoves: stageMoves.map((r) => ({ createdAt: new Date(r.created_at) })),
    activities: activities.map((r) => ({ type: r.type, at: new Date(r.at) })),
    uploads: uploads.map((r) => ({ at: new Date(r.at) })),
  };
}
```

> **Schema-name check for the engineer:** confirm `activities` uses `responsible_user_id` and an `occurred_at` column (grep `shared/src/schema/tenant/activities.ts`); confirm `files.uploaded_by` (Task investigation found it). Adjust column names here to match exactly before running.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run server/tests/scripts/usage-raw-fetch.runtime.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add server/src/modules/usage/raw-fetch.ts server/tests/scripts/usage-raw-fetch.runtime.test.ts
git commit -m "feat(usage): fetchRawUsageForDay — single fetch shared by live + rollup"
```

---

## Task 13: `GET /api/reports/platform-usage` (summary + leaderboard, scoped)

**Files:**
- Create: `server/src/modules/usage/read-service.ts`
- Modify: `server/src/modules/reports/routes.ts`
- Test: `server/src/modules/usage/read-service.test.ts`

Read service responsibilities: resolve the date list for `grain` (day → [date]; week → 7 dates), for each rep+date load the row (today computed live via `fetchRawUsageForDay`+`computeUsageDaily`; past days read from `usage_daily`), sum a week, build the team summary + leaderboard. The **route** enforces rep-self scoping.

- [ ] **Step 1: Write the failing test (scoping + week date math)**

```ts
// server/src/modules/usage/read-service.test.ts
import { describe, expect, it } from "vitest";
import { resolveRepScope, weekDates } from "./read-service.js";

describe("resolveRepScope (server-enforced)", () => {
  it("forces a rep to themselves regardless of requested rep", () => {
    expect(resolveRepScope({ role: "rep", userId: "rep-1" }, "rep-9")).toEqual(["rep-1"]);
  });
  it("lets a director request a specific rep", () => {
    expect(resolveRepScope({ role: "director", userId: "dir-1" }, "rep-9")).toEqual(["rep-9"]);
  });
  it("lets an admin request all reps (null filter)", () => {
    expect(resolveRepScope({ role: "admin", userId: "adm-1" }, undefined)).toBeNull();
  });
});

describe("weekDates", () => {
  it("returns the 7 ISO dates of the week containing the anchor (Mon-Sun)", () => {
    expect(weekDates("2026-06-10")).toEqual([
      "2026-06-08", "2026-06-09", "2026-06-10", "2026-06-11", "2026-06-12", "2026-06-13", "2026-06-14",
    ]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run server/src/modules/usage/read-service.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the read service**

```ts
// server/src/modules/usage/read-service.ts
import type { UsageDailyShape } from "./types.js";
import { computeUsageDaily } from "./aggregate.js";
import { fetchRawUsageForDay, type QueryClient } from "./raw-fetch.js";

export interface Requester { role: string; userId: string; }

/** Server-enforced scoping: reps are forced to self; admin/director may target one rep or all (null). */
export function resolveRepScope(req: Requester, requestedRep: string | undefined): string[] | null {
  if (req.role === "rep") return [req.userId];
  if (requestedRep) return [requestedRep];
  return null; // all reps
}

/** ISO dates (Mon..Sun) of the week containing `anchor` (YYYY-MM-DD), in UTC. */
export function weekDates(anchor: string): string[] {
  const d = new Date(`${anchor}T00:00:00Z`);
  const dow = (d.getUTCDay() + 6) % 7; // 0 = Monday
  const monday = new Date(d);
  monday.setUTCDate(d.getUTCDate() - dow);
  return Array.from({ length: 7 }, (_, i) => {
    const day = new Date(monday);
    day.setUTCDate(monday.getUTCDate() + i);
    return day.toISOString().slice(0, 10);
  });
}

/** The live "today" caller: fetch raw rows + fold. Imported by byte-identical.test.ts (Task 7). */
export async function buildLiveDay(
  client: QueryClient, schema: string, userId: string, date: string,
): Promise<UsageDailyShape> {
  const raw = await fetchRawUsageForDay(client, schema, userId, date);
  return computeUsageDaily(raw);
}

/** Sum a set of daily shapes into one (used for weekly grain). */
export function sumDays(userId: string, label: string, days: UsageDailyShape[]): UsageDailyShape {
  const acc: UsageDailyShape = {
    userId, date: label, activeSeconds: 0, sessionCount: 0, viewCount: 0, actionCount: 0,
    breakdown: { deal_views: 0, lead_views: 0, report_views: 0, page_views: 0, creates: 0, edits: 0, stage_moves: 0, uploads: 0, activities: {} },
    firstActiveAt: null, lastActiveAt: null,
  };
  let hasTime = false;
  for (const d of days) {
    acc.activeSeconds += d.activeSeconds;
    acc.sessionCount += d.sessionCount;
    acc.viewCount += d.viewCount;
    acc.actionCount += d.actionCount;
    acc.breakdown.deal_views += d.breakdown.deal_views;
    acc.breakdown.lead_views += d.breakdown.lead_views;
    acc.breakdown.report_views += d.breakdown.report_views;
    acc.breakdown.page_views += d.breakdown.page_views;
    acc.breakdown.creates += d.breakdown.creates;
    acc.breakdown.edits += d.breakdown.edits;
    acc.breakdown.stage_moves += d.breakdown.stage_moves;
    acc.breakdown.uploads += d.breakdown.uploads;
    for (const [k, v] of Object.entries(d.breakdown.activities)) {
      acc.breakdown.activities[k] = (acc.breakdown.activities[k] ?? 0) + v;
    }
    if (d.firstActiveAt) { hasTime = true; if (!acc.firstActiveAt || d.firstActiveAt < acc.firstActiveAt) acc.firstActiveAt = d.firstActiveAt; }
    if (d.lastActiveAt) { if (!acc.lastActiveAt || d.lastActiveAt > acc.lastActiveAt) acc.lastActiveAt = d.lastActiveAt; }
  }
  // Leaderboard time-sort treats "no data" as absent: keep activeSeconds 0 but a null marker.
  if (!hasTime) { acc.firstActiveAt = null; acc.lastActiveAt = null; }
  return acc;
}
```

> **Engineer note:** the route handler (next step) is where `usage_daily` lookups for past days happen; the read of historical `usage_daily` rows and the per-rep list of users are wired in the route using `req.tenantDb` raw SQL. The pure helpers above (`resolveRepScope`, `weekDates`, `sumDays`, `buildLiveDay`) are unit-tested; the route is covered by the scoping test in Task 13 Step 5 and an integration smoke check.

- [ ] **Step 4: Add the route to reports**

In `server/src/modules/reports/routes.ts`, add (mirroring the existing report GET handlers):

```ts
import { resolveRepScope, weekDates, buildLiveDay, sumDays } from "../usage/read-service.js";
// (and a small helper to read usage_daily history + the rep roster via req.tenantClient)

router.get("/platform-usage", async (req, res, next) => {
  try {
    const grain = req.query.grain === "week" ? "week" : "day";
    const anchor = typeof req.query.date === "string" ? req.query.date : new Date().toISOString().slice(0, 10);
    const today = new Date().toISOString().slice(0, 10);
    const dates = grain === "week" ? weekDates(anchor) : [anchor];

    const scope = resolveRepScope({ role: req.user!.role, userId: req.user!.id }, typeof req.query.rep === "string" ? req.query.rep : undefined);
    const schema = `office_${req.officeSlug!}`;
    const client = req.tenantClient!; // pg client on the request transaction

    // Resolve the rep roster (scoped). When scope is null (admin/director all), list active users.
    const reps = await resolveReps(client, schema, scope);

    const rows = [];
    for (const rep of reps) {
      const days = [];
      for (const d of dates) {
        days.push(d >= today ? await buildLiveDay(client, schema, rep.id, d) : await readUsageDaily(client, schema, rep.id, d));
      }
      const folded = grain === "week" ? sumDays(rep.id, `week-of-${dates[0]}`, days) : days[0];
      rows.push({ rep, usage: folded });
    }

    await req.commitTransaction!();
    res.json({ data: { grain, dates, summary: buildTeamSummary(rows), leaderboard: rows } });
  } catch (err) {
    next(err);
  }
});
```

Add these helpers to `read-service.ts` (raw SQL against `usage_daily` + the user roster). Confirm `public.users` column names (`display_name`, `role`, `is_active`) against `shared/src/schema/public/users.ts` before running; adjust if they differ.

```ts
// append to server/src/modules/usage/read-service.ts
// (QueryClient is already imported at the top of this file from ./raw-fetch.js)

const SCHEMA_RE = /^office_[a-z0-9_]+$/;
export interface RepRef { id: string; displayName: string; }

const ZERO_BREAKDOWN = () => ({
  deal_views: 0, lead_views: 0, report_views: 0, page_views: 0,
  creates: 0, edits: 0, stage_moves: 0, uploads: 0, activities: {} as Record<string, number>,
});

/** Resolve the rep roster for the request. scope=null → all active reps; else exactly those ids. */
export async function resolveReps(client: QueryClient, schema: string, scope: string[] | null): Promise<RepRef[]> {
  if (!SCHEMA_RE.test(schema)) throw new Error(`invalid schema: ${schema}`);
  if (scope) {
    if (scope.length === 0) return [];
    const placeholders = scope.map((_, i) => `$${i + 1}`).join(",");
    const { rows } = await client.query<{ id: string; display_name: string }>(
      `SELECT id, display_name FROM public.users WHERE id IN (${placeholders})`, scope,
    );
    return rows.map((r) => ({ id: r.id, displayName: r.display_name }));
  }
  const { rows } = await client.query<{ id: string; display_name: string }>(
    `SELECT id, display_name FROM public.users WHERE role = 'rep' AND is_active = true ORDER BY display_name`,
  );
  return rows.map((r) => ({ id: r.id, displayName: r.display_name }));
}

/** Read one rolled-up day; returns a zeroed shape when no usage_daily row exists (pre-launch days). */
export async function readUsageDaily(client: QueryClient, schema: string, userId: string, date: string): Promise<UsageDailyShape> {
  if (!SCHEMA_RE.test(schema)) throw new Error(`invalid schema: ${schema}`);
  const { rows } = await client.query<{
    active_seconds: number; session_count: number; view_count: number; action_count: number;
    breakdown: UsageDailyShape["breakdown"]; first_active_at: string | null; last_active_at: string | null;
  }>(
    `SELECT active_seconds, session_count, view_count, action_count, breakdown, first_active_at, last_active_at
       FROM ${schema}.usage_daily WHERE user_id = $1 AND date = $2`,
    [userId, date],
  );
  const r = rows[0];
  if (!r) return { userId, date, activeSeconds: 0, sessionCount: 0, viewCount: 0, actionCount: 0, breakdown: ZERO_BREAKDOWN(), firstActiveAt: null, lastActiveAt: null };
  return {
    userId, date, activeSeconds: r.active_seconds, sessionCount: r.session_count, viewCount: r.view_count,
    actionCount: r.action_count, breakdown: r.breakdown, firstActiveAt: r.first_active_at, lastActiveAt: r.last_active_at,
  };
}

/** Team summary strip. "active today" := activeSeconds > 0 (>=1 heartbeat) — applied consistently. */
export function buildTeamSummary(rows: { rep: RepRef; usage: UsageDailyShape }[]) {
  let activeSeconds = 0, actionCount = 0, activeReps = 0;
  for (const { usage } of rows) {
    activeSeconds += usage.activeSeconds;
    actionCount += usage.actionCount;
    if (usage.activeSeconds > 0) activeReps++;
  }
  return { activeSeconds, actionCount, activeReps, totalReps: rows.length };
}
```

- [ ] **Step 5: Add the route scoping test**

```ts
// server/tests/usage-platform-usage-scope.test.ts
import { describe, expect, it } from "vitest";
import { resolveRepScope } from "../src/modules/usage/read-service.js";

describe("platform-usage endpoint scoping", () => {
  it("a rep can never widen scope to another rep via the query param", () => {
    expect(resolveRepScope({ role: "rep", userId: "rep-1" }, "rep-2")).toEqual(["rep-1"]);
  });
});
```

- [ ] **Step 6: Run tests + typecheck**

Run: `npx vitest run server/src/modules/usage/read-service.test.ts server/tests/usage-platform-usage-scope.test.ts`
Expected: PASS.
Run: `npm run typecheck --workspace=server`
Expected: clean.

- [ ] **Step 7: Commit**

```bash
git add server/src/modules/usage/read-service.ts server/src/modules/reports/routes.ts server/src/modules/usage/read-service.test.ts server/tests/usage-platform-usage-scope.test.ts
git commit -m "feat(usage): GET /reports/platform-usage (summary + leaderboard, rep-self scoped)"
```

---

## Task 14: `GET /api/reports/platform-usage/drilldown` (scoped, 14-day window)

**Files:**
- Modify: `server/src/modules/usage/read-service.ts`
- Modify: `server/src/modules/reports/routes.ts`
- Test: `server/tests/usage-drilldown-scope.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// server/tests/usage-drilldown-scope.test.ts
import { describe, expect, it } from "vitest";
import { resolveRepScope, isWithinDrilldownWindow } from "../src/modules/usage/read-service.js";

describe("drilldown scoping + window", () => {
  it("applies the identical rep-self scope as the summary", () => {
    expect(resolveRepScope({ role: "rep", userId: "rep-1" }, "rep-2")).toEqual(["rep-1"]);
  });
  it("rejects dates older than the 14-day raw window", () => {
    expect(isWithinDrilldownWindow("2026-06-09", "2026-06-09")).toBe(true);
    expect(isWithinDrilldownWindow("2026-05-20", "2026-06-09")).toBe(false); // 20 days old
    expect(isWithinDrilldownWindow("2026-05-27", "2026-06-09")).toBe(true);  // 13 days old
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run server/tests/usage-drilldown-scope.test.ts`
Expected: FAIL — `isWithinDrilldownWindow` not exported.

- [ ] **Step 3: Add the window helper + route**

In `read-service.ts`:

```ts
import { RAW_RETENTION_DAYS } from "./constants.js";

export function isWithinDrilldownWindow(date: string, today: string): boolean {
  const ms = new Date(`${today}T00:00:00Z`).getTime() - new Date(`${date}T00:00:00Z`).getTime();
  const days = Math.floor(ms / 86_400_000);
  return days >= 0 && days < RAW_RETENTION_DAYS;
}
```

In `reports/routes.ts`:

```ts
router.get("/platform-usage/drilldown", async (req, res, next) => {
  try {
    const date = typeof req.query.date === "string" ? req.query.date : "";
    const type = typeof req.query.type === "string" ? req.query.type : undefined;
    const today = new Date().toISOString().slice(0, 10);

    const scope = resolveRepScope({ role: req.user!.role, userId: req.user!.id }, typeof req.query.rep === "string" ? req.query.rep : undefined);
    const repId = scope ? scope[0] : (typeof req.query.rep === "string" ? req.query.rep : req.user!.id);

    if (!isWithinDrilldownWindow(date, today)) {
      await req.commitTransaction!();
      res.json({ data: { expired: true, events: [], message: "counts only — drilldown expired" } });
      return;
    }

    const events = await readViewEvents(req.tenantClient!, `office_${req.officeSlug!}`, repId, date, type);
    await req.commitTransaction!();
    res.json({ data: { expired: false, events } });
  } catch (err) {
    next(err);
  }
});
```

Add `readViewEvents` to `read-service.ts`:

```ts
// append to server/src/modules/usage/read-service.ts
export interface ViewEventRow { at: string; entity_type: string; entity_id: string | null; route: string; label_snapshot: string | null; }

/** Raw view events for one user+day, optionally filtered by entity_type, ordered chronologically. */
export async function readViewEvents(
  client: QueryClient, schema: string, userId: string, date: string, type?: string,
): Promise<ViewEventRow[]> {
  if (!SCHEMA_RE.test(schema)) throw new Error(`invalid schema: ${schema}`);
  const params: unknown[] = [userId, `${date}T00:00:00Z`];
  let typeClause = "";
  if (type) { params.push(type); typeClause = " AND entity_type = $3"; }
  const { rows } = await client.query<ViewEventRow>(
    `SELECT at, entity_type, entity_id, route, label_snapshot FROM ${schema}.usage_view_event
       WHERE user_id = $1 AND at >= $2::timestamptz AND at < $2::timestamptz + interval '1 day'${typeClause}
       ORDER BY at`,
    params,
  );
  return rows;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run server/tests/usage-drilldown-scope.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/modules/usage/read-service.ts server/src/modules/reports/routes.ts server/tests/usage-drilldown-scope.test.ts
git commit -m "feat(usage): GET /reports/platform-usage/drilldown (scoped, 14-day window)"
```

---

## Task 15: Rollup + gated prune script (per-office fan-out)

**Files:**
- Create: `server/src/scripts/usage-rollup.ts`
- Modify: `server/package.json`
- Test: `server/tests/scripts/usage-rollup.runtime.test.ts` (PGlite)

The script (run by a Railway cron service, like `hubspot-refresh-nightly`): for each `office_*` schema, for each completed day not yet rolled up, for each user with raw rows, `fetchRawUsageForDay` → `computeUsageDaily` → upsert `usage_daily` (`rolled_up_at = now()`); then prune `usage_heartbeat`/`usage_view_event` for days with a `rolled_up_at` row older than 14 days. Prune is **inside** the per-office loop and **gated on `rolled_up_at`**.

- [ ] **Step 1: Write the failing PGlite test**

```ts
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
  // Two office schemas, to prove fan-out across both.
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
    // 2026-06-01 is rolled up but only ~ < 14 days before 2026-06-10; prune as of 2026-06-30 should delete.
    await pruneRolledUpRaw(client(), "office_dallas", "2026-06-30");
    const { rows } = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM office_dallas.usage_heartbeat`);
    expect(rows[0].n).toBe(0);
  });

  it("prune does NOT delete raw rows for a day with no usage_daily row", async () => {
    // Insert an un-rolled raw heartbeat on a new day in atlanta; prune must leave it.
    await db.exec(`INSERT INTO office_atlanta.usage_heartbeat (session_id, user_id, at) VALUES ('${U("00a1")}', '${REP}', '2026-06-05T10:00:00Z');`);
    await pruneRolledUpRaw(client(), "office_atlanta", "2026-06-30");
    const { rows } = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM office_atlanta.usage_heartbeat WHERE at='2026-06-05T10:00:00Z'`);
    expect(rows[0].n).toBe(1); // un-rolled day survived
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run server/tests/scripts/usage-rollup.runtime.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the rollup script**

```ts
// server/src/scripts/usage-rollup.ts
import pg from "pg";
import { fetchRawUsageForDay, type QueryClient } from "../modules/usage/raw-fetch.js";
import { computeUsageDaily } from "../modules/usage/aggregate.js";
import { RAW_RETENTION_DAYS } from "../modules/usage/constants.js";

const SCHEMA_RE = /^office_[a-z0-9_]+$/;

/** Roll up one completed day for one office: fold each active user and upsert usage_daily. */
export async function rollupOfficeDay(client: QueryClient, schema: string, date: string): Promise<void> {
  if (!SCHEMA_RE.test(schema)) throw new Error(`invalid schema: ${schema}`);
  // Distinct users who produced ANY raw signal that day.
  const { rows: users } = await client.query<{ user_id: string }>(
    `SELECT DISTINCT user_id FROM (
        SELECT user_id FROM ${schema}.usage_session  WHERE started_at >= $1::timestamptz AND started_at < $1::timestamptz + interval '1 day'
        UNION SELECT changed_by FROM ${schema}.audit_log WHERE created_at >= $1::timestamptz AND created_at < $1::timestamptz + interval '1 day'
        UNION SELECT changed_by FROM ${schema}.deal_stage_history WHERE created_at >= $1::timestamptz AND created_at < $1::timestamptz + interval '1 day'
        UNION SELECT responsible_user_id FROM ${schema}.activities WHERE COALESCE(occurred_at, created_at) >= $1::timestamptz AND COALESCE(occurred_at, created_at) < $1::timestamptz + interval '1 day'
        UNION SELECT uploaded_by FROM ${schema}.files WHERE created_at >= $1::timestamptz AND created_at < $1::timestamptz + interval '1 day'
      ) u WHERE user_id IS NOT NULL`,
    [`${date}T00:00:00Z`],
  );

  for (const { user_id } of users) {
    const raw = await fetchRawUsageForDay(client, schema, user_id, date);
    const shape = computeUsageDaily(raw);
    await client.query(
      `INSERT INTO ${schema}.usage_daily
         (user_id, date, active_seconds, session_count, view_count, action_count, breakdown, first_active_at, last_active_at, rolled_up_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9, now())
       ON CONFLICT (user_id, date) DO UPDATE SET
         active_seconds=EXCLUDED.active_seconds, session_count=EXCLUDED.session_count,
         view_count=EXCLUDED.view_count, action_count=EXCLUDED.action_count,
         breakdown=EXCLUDED.breakdown, first_active_at=EXCLUDED.first_active_at,
         last_active_at=EXCLUDED.last_active_at, rolled_up_at=now()`,
      [shape.userId, shape.date, shape.activeSeconds, shape.sessionCount, shape.viewCount,
       shape.actionCount, JSON.stringify(shape.breakdown), shape.firstActiveAt, shape.lastActiveAt],
    );
  }
}

/**
 * Gated prune: delete raw heartbeats/view-events only for days that (a) have a usage_daily
 * rolled-up row and (b) are older than RAW_RETENTION_DAYS relative to `asOf`.
 */
export async function pruneRolledUpRaw(client: QueryClient, schema: string, asOf: string): Promise<void> {
  if (!SCHEMA_RE.test(schema)) throw new Error(`invalid schema: ${schema}`);
  const cutoff = `${asOf}T00:00:00Z`;
  for (const table of ["usage_heartbeat", "usage_view_event"]) {
    await client.query(
      `DELETE FROM ${schema}.${table} raw
        WHERE raw.at < $1::timestamptz - ($2 || ' days')::interval
          AND EXISTS (
            SELECT 1 FROM ${schema}.usage_daily d
             WHERE d.user_id = raw.user_id AND d.date = (raw.at AT TIME ZONE 'UTC')::date
          )`,
      [cutoff, String(RAW_RETENTION_DAYS)],
    );
  }
}

/** Entry point: fan out across all office schemas. */
export async function main(): Promise<void> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error("DATABASE_URL is required");
  const pgClient = new pg.Client({ connectionString });
  await pgClient.connect();
  const client: QueryClient = { query: (sql, params) => pgClient.query(sql, params as unknown[]) as any };
  try {
    const { rows: schemas } = await client.query<{ schema_name: string }>(
      `SELECT schema_name FROM information_schema.schemata WHERE schema_name LIKE 'office_%' ORDER BY schema_name`,
    );
    const today = new Date().toISOString().slice(0, 10);
    const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
    for (const { schema_name } of schemas) {
      if (!SCHEMA_RE.test(schema_name)) continue;
      await rollupOfficeDay(client, schema_name, yesterday); // most recent completed day
      await pruneRolledUpRaw(client, schema_name, today);
    }
  } finally {
    await pgClient.end();
  }
}

// Allow direct execution: `tsx src/scripts/usage-rollup.ts`
if (process.argv[1] && process.argv[1].endsWith("usage-rollup.ts")) {
  main().catch((err) => { console.error(err); process.exit(1); });
}
```

> **Engineer note:** `Date.now()`/`new Date()` are fine in this script (it runs in Node, not a workflow). The rollup folds only the most recent completed day per run; if you need to backfill multiple missed days, loop `yesterday` back N days. Keep that out of v1 unless the cron has been down.

- [ ] **Step 4: Add the npm script**

In `server/package.json` `"scripts"`, add: `"usage:rollup": "tsx src/scripts/usage-rollup.ts"`.

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run server/tests/scripts/usage-rollup.runtime.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 6: Commit**

```bash
git add server/src/scripts/usage-rollup.ts server/package.json server/tests/scripts/usage-rollup.runtime.test.ts
git commit -m "feat(usage): nightly rollup + gated prune script (per-office fan-out)"
```

> **Ops follow-up (not code):** configure a Railway cron service to run `npm run usage:rollup` nightly (mirror `hubspot-refresh-nightly`). Record this in the deploy runbook; it is outside the repo.

---

## Task 16: `usePlatformUsageTracker` client hook

**Files:**
- Create: `client/src/hooks/use-platform-usage-tracker.ts`
- Test: `client/src/hooks/use-platform-usage-tracker.test.ts`

Behavior: on mount (authenticated) → `POST /usage/session/start` → store `sessionId`. Heartbeat every `HEARTBEAT_INTERVAL_S` only when `document.visibilityState === "visible"` AND last interaction < 5 min ago. Buffer view events; flush every ~10s and on navigation; `navigator.sendBeacon` on `pagehide`. Use the `api()` client for normal posts.

- [ ] **Step 1: Write the failing test (fake timers + visibility/idle)**

```ts
// client/src/hooks/use-platform-usage-tracker.test.ts
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { shouldSendHeartbeat } from "./use-platform-usage-tracker.js";

describe("shouldSendHeartbeat", () => {
  it("sends when visible and recently interacted", () => {
    expect(shouldSendHeartbeat({ visibility: "visible", msSinceInteraction: 1000, idleMs: 300_000 })).toBe(true);
  });
  it("does not send when tab hidden", () => {
    expect(shouldSendHeartbeat({ visibility: "hidden", msSinceInteraction: 1000, idleMs: 300_000 })).toBe(false);
  });
  it("does not send after the idle threshold", () => {
    expect(shouldSendHeartbeat({ visibility: "visible", msSinceInteraction: 400_000, idleMs: 300_000 })).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run client/src/hooks/use-platform-usage-tracker.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the hook (pure gate + effect)**

```ts
// client/src/hooks/use-platform-usage-tracker.ts
import { useEffect, useRef } from "react";
import { useLocation } from "react-router-dom";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";

const HEARTBEAT_INTERVAL_MS = 30_000;
const IDLE_MS = 300_000; // 5 minutes
const VIEW_FLUSH_MS = 10_000;

/** Pure decision: should a heartbeat fire right now? Exported for unit testing. */
export function shouldSendHeartbeat(s: { visibility: string; msSinceInteraction: number; idleMs: number }): boolean {
  return s.visibility === "visible" && s.msSinceInteraction < s.idleMs;
}

interface BufferedView { entityType: string; entityId: string | null; route: string; labelSnapshot: string | null; }

export function usePlatformUsageTracker(): void {
  const { user } = useAuth();
  const location = useLocation();
  const sessionIdRef = useRef<string | null>(null);
  const lastInteractionRef = useRef<number>(Date.now());
  const viewBufferRef = useRef<BufferedView[]>([]);

  // 1) Start a session once authenticated.
  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    void api<{ sessionId: string }>("/usage/session/start", { method: "POST" })
      .then((r) => { if (!cancelled) sessionIdRef.current = r.sessionId; })
      .catch(() => { /* telemetry is best-effort; never block the app */ });
    return () => { cancelled = true; };
  }, [user]);

  // 2) Track interaction recency.
  useEffect(() => {
    const mark = () => { lastInteractionRef.current = Date.now(); };
    const events = ["mousemove", "keydown", "click", "scroll"] as const;
    for (const e of events) window.addEventListener(e, mark, { passive: true });
    return () => { for (const e of events) window.removeEventListener(e, mark); };
  }, []);

  // 3) Heartbeat loop (visibility + idle gated).
  useEffect(() => {
    if (!user) return;
    const id = window.setInterval(() => {
      const sid = sessionIdRef.current;
      if (!sid) return;
      const ok = shouldSendHeartbeat({
        visibility: document.visibilityState,
        msSinceInteraction: Date.now() - lastInteractionRef.current,
        idleMs: IDLE_MS,
      });
      if (!ok) return;
      void api("/usage/heartbeat", { method: "POST", body: JSON.stringify({ sessionId: sid }) }).catch(() => {});
    }, HEARTBEAT_INTERVAL_MS);
    return () => window.clearInterval(id);
  }, [user]);

  // 4) Record a view on each route change (buffered).
  useEffect(() => {
    if (!user) return;
    viewBufferRef.current.push(classifyRoute(location.pathname));
    lastInteractionRef.current = Date.now();
  }, [user, location.pathname]);

  // 5) Flush buffer on interval, on navigation, and on pagehide (beacon).
  useEffect(() => {
    if (!user) return;
    const flush = (useBeacon = false) => {
      const sid = sessionIdRef.current;
      const events = viewBufferRef.current;
      if (!sid || events.length === 0) return;
      viewBufferRef.current = [];
      const payload = JSON.stringify({ sessionId: sid, events });
      if (useBeacon && navigator.sendBeacon) {
        navigator.sendBeacon("/api/usage/events", new Blob([payload], { type: "application/json" }));
      } else {
        void api("/usage/events", { method: "POST", body: payload }).catch(() => {});
      }
    };
    const id = window.setInterval(() => flush(false), VIEW_FLUSH_MS);
    const onHide = () => flush(true);
    window.addEventListener("pagehide", onHide);
    return () => { window.clearInterval(id); window.removeEventListener("pagehide", onHide); flush(false); };
  }, [user]);
}

/** Map a route path to a view-event classification. */
export function classifyRoute(pathname: string): BufferedView {
  const dealMatch = pathname.match(/^\/deals\/([0-9a-f-]{36})/i);
  if (dealMatch) return { entityType: "deal", entityId: dealMatch[1], route: pathname, labelSnapshot: null };
  const leadMatch = pathname.match(/^\/leads\/([0-9a-f-]{36})/i);
  if (leadMatch) return { entityType: "lead", entityId: leadMatch[1], route: pathname, labelSnapshot: null };
  if (pathname.startsWith("/reports")) return { entityType: "report", entityId: null, route: pathname, labelSnapshot: null };
  return { entityType: "page", entityId: null, route: pathname, labelSnapshot: null };
}
```

> **Engineer note:** confirm the `api()` signature in `client/src/lib/api.ts` (method/body options). If `api` always sets `Content-Type: application/json` and stringifies, pass the object directly instead of `JSON.stringify`. The `sendBeacon` path posts to the absolute `/api/usage/events` (beacon bypasses the `api` base-path wrapper) — verify the API base path; if the app is served under the same origin with `/api` prefix this is correct.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run client/src/hooks/use-platform-usage-tracker.test.ts`
Expected: PASS (3 tests for `shouldSendHeartbeat`).

- [ ] **Step 5: Add a classifyRoute test**

```ts
// append to use-platform-usage-tracker.test.ts
import { classifyRoute } from "./use-platform-usage-tracker.js";
describe("classifyRoute", () => {
  it("classifies deal, lead, report, and generic pages", () => {
    expect(classifyRoute("/deals/00000000-0000-4000-8000-000000000001").entityType).toBe("deal");
    expect(classifyRoute("/leads/00000000-0000-4000-8000-000000000001").entityType).toBe("lead");
    expect(classifyRoute("/reports/performance/platform-usage").entityType).toBe("report");
    expect(classifyRoute("/pipeline").entityType).toBe("page");
  });
});
```

Run: `npx vitest run client/src/hooks/use-platform-usage-tracker.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add client/src/hooks/use-platform-usage-tracker.ts client/src/hooks/use-platform-usage-tracker.test.ts
git commit -m "feat(usage): usePlatformUsageTracker client hook (heartbeat/views, idle+visibility gated)"
```

---

## Task 17: Mount the tracker in the app shell

**Files:**
- Modify: `client/src/components/layout/app-shell.tsx`
- Test: `client/src/components/layout/app-shell.test.tsx`

- [ ] **Step 1: Write the failing test**

```tsx
// client/src/components/layout/app-shell.test.tsx
import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";

describe("AppShell mounts the usage tracker", () => {
  it("calls usePlatformUsageTracker once", () => {
    const src = readFileSync(new URL("./app-shell.tsx", import.meta.url), "utf8");
    expect(src).toContain("usePlatformUsageTracker");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run client/src/components/layout/app-shell.test.tsx`
Expected: FAIL — string absent.

- [ ] **Step 3: Mount the hook**

In `client/src/components/layout/app-shell.tsx`:
- Add import: `import { usePlatformUsageTracker } from "@/hooks/use-platform-usage-tracker";`
- Call it as the first line inside `AppShell()`: `usePlatformUsageTracker();`

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run client/src/components/layout/app-shell.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add client/src/components/layout/app-shell.tsx client/src/components/layout/app-shell.test.tsx
git commit -m "feat(usage): mount usePlatformUsageTracker in AppShell"
```

---

## Task 18: Platform Usage page + read hook + route + Reports card

**Files:**
- Create: `client/src/hooks/use-platform-usage-report.ts`
- Create: `client/src/pages/reports/platform-usage-page.tsx`
- Modify: `client/src/App.tsx`
- Modify: `client/src/pages/reports/reports-page.tsx`
- Test: `client/src/pages/reports/platform-usage-page.test.tsx`

- [ ] **Step 1: Write the failing page test**

```tsx
// client/src/pages/reports/platform-usage-page.test.tsx
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";

vi.mock("@/hooks/use-platform-usage-report", () => ({
  usePlatformUsageReport: () => ({
    loading: false,
    error: null,
    data: {
      grain: "week",
      dates: ["2026-06-08"],
      summary: { activeSeconds: 147600, actionCount: 680, activeReps: 8, totalReps: 10 },
      leaderboard: [
        { rep: { id: "r1", displayName: "Kaleb" }, usage: { activeSeconds: 51600, actionCount: 312, sessionCount: 5, breakdown: { activities: {} } } },
        { rep: { id: "r2", displayName: "Adnaan" }, usage: { activeSeconds: 32700, actionCount: 188, sessionCount: 4, breakdown: { activities: {} } } },
      ],
    },
  }),
}));

vi.mock("@/components/reports/report-filter-bar", () => ({
  ReportFilterBar: () => <div>Filters</div>,
  useReportFilters: () => ({ filters: {}, query: {} }),
}));

import { PlatformUsagePage } from "./platform-usage-page";

describe("PlatformUsagePage", () => {
  it("renders the team summary and a rep leaderboard", () => {
    const html = renderToStaticMarkup(<MemoryRouter><PlatformUsagePage /></MemoryRouter>).replace(/\s+/g, " ");
    expect(html).toContain("Platform Usage");
    expect(html).toContain("Kaleb");
    expect(html).toContain("Adnaan");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run client/src/pages/reports/platform-usage-page.test.tsx`
Expected: FAIL — page module not found.

- [ ] **Step 3: Implement the read hook**

```ts
// client/src/hooks/use-platform-usage-report.ts
import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/api";

export interface PlatformUsageRow {
  rep: { id: string; displayName: string };
  usage: {
    activeSeconds: number;
    actionCount: number;
    sessionCount: number;
    viewCount?: number;
    firstActiveAt?: string | null;
    breakdown: { activities: Record<string, number>; [k: string]: unknown };
  };
}
export interface PlatformUsageReport {
  grain: "day" | "week";
  dates: string[];
  summary: { activeSeconds: number; actionCount: number; activeReps: number; totalReps: number };
  leaderboard: PlatformUsageRow[];
}

export function usePlatformUsageReport(params: { grain: "day" | "week"; date?: string; rep?: string }) {
  const [data, setData] = useState<PlatformUsageReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchReport = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const qs = new URLSearchParams({ grain: params.grain });
      if (params.date) qs.set("date", params.date);
      if (params.rep) qs.set("rep", params.rep);
      const result = await api<{ data: PlatformUsageReport }>(`/reports/platform-usage?${qs.toString()}`);
      setData(result.data);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to load platform usage");
      setData(null);
    } finally {
      setLoading(false);
    }
  }, [params.grain, params.date, params.rep]);

  useEffect(() => { void fetchReport(); }, [fetchReport]);
  return { data, loading, error, refetch: fetchReport };
}

/** Format seconds as "Hh Mm". */
export function formatActiveTime(seconds: number): string {
  if (seconds <= 0) return "—";
  const h = Math.floor(seconds / 3600);
  const m = Math.round((seconds % 3600) / 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}
```

- [ ] **Step 4: Implement the page**

```tsx
// client/src/pages/reports/platform-usage-page.tsx
import { useMemo, useState } from "react";
import { PageHeader } from "@/components/layout/page-header";
import { usePlatformUsageReport, formatActiveTime, type PlatformUsageRow } from "@/hooks/use-platform-usage-report";

export function PlatformUsagePage() {
  const [grain, setGrain] = useState<"day" | "week">("week");
  const { data, loading, error } = usePlatformUsageReport({ grain });

  const rows = useMemo<PlatformUsageRow[]>(() => {
    if (!data) return [];
    // Time sort: reps with no active time ("—") sort last, never as zero.
    return [...data.leaderboard].sort((a, b) => {
      const at = a.usage.activeSeconds, bt = b.usage.activeSeconds;
      if (at === 0 && bt === 0) return b.usage.actionCount - a.usage.actionCount;
      if (at === 0) return 1;
      if (bt === 0) return -1;
      return bt - at;
    });
  }, [data]);

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Performance"
        title="Platform Usage"
        description="Active time, actions, and views per rep — daily and weekly."
      />

      <div className="flex gap-2">
        <button type="button" onClick={() => setGrain("day")} className={grain === "day" ? "font-bold" : ""}>Daily</button>
        <button type="button" onClick={() => setGrain("week")} className={grain === "week" ? "font-bold" : ""}>Weekly</button>
      </div>

      {loading ? <p>Loading…</p> : null}
      {error ? <p className="text-brand-red">{error}</p> : null}

      {data ? (
        <>
          <div className="grid grid-cols-3 gap-4">
            <SummaryCell label="Active time" value={formatActiveTime(data.summary.activeSeconds)} />
            <SummaryCell label="Actions" value={String(data.summary.actionCount)} />
            <SummaryCell label="Reps active" value={`${data.summary.activeReps}/${data.summary.totalReps}`} />
          </div>

          <table className="w-full text-left text-sm">
            <thead>
              <tr><th>Rep</th><th>Active time</th><th>Actions</th><th>Sessions</th></tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.rep.id}>
                  <td>{r.rep.displayName}</td>
                  <td>{formatActiveTime(r.usage.activeSeconds)}</td>
                  <td>{r.usage.actionCount}</td>
                  <td>{r.usage.sessionCount}</td>
                </tr>
              ))}
            </tbody>
          </table>

          <p className="text-xs text-slate-500">
            Note: impersonated stage changes, logged activities, and uploads attribute to the impersonated rep
            (time and views are excluded). Pre-launch days show “—” for time and views.
          </p>
        </>
      ) : null}
    </div>
  );
}

function SummaryCell({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border p-4">
      <div className="text-xs uppercase text-slate-500">{label}</div>
      <div className="text-2xl font-bold">{value}</div>
    </div>
  );
}
```

> **Engineer note:** confirm `PageHeader` import path matches the one used by `rep-activity-page.tsx` (Task investigation referenced `PageHeader` with `eyebrow/title/description`). If the project uses a different header component, mirror `rep-activity-page.tsx` exactly.

- [ ] **Step 5: Register the route in App.tsx**

In `client/src/App.tsx`, near the other `/reports/performance/*` routes, add:

```tsx
<Route
  path="/reports/performance/platform-usage"
  element={(
    <RequireRole allowedRoles={["admin", "director", "rep"]}>
      <PlatformUsagePage />
    </RequireRole>
  )}
/>
```

Add the import: `import { PlatformUsagePage } from "@/pages/reports/platform-usage-page";`

- [ ] **Step 6: Add the Reports index card**

In `client/src/pages/reports/reports-page.tsx`, add to the Performance category's `reports` array (mirror the existing card objects), choosing an imported lucide icon already in scope (e.g. `Activity`):

```tsx
{
  name: "Platform Usage",
  description: "Active time, actions, and views per rep — daily and weekly.",
  icon: Activity,
  path: "/reports/performance/platform-usage",
},
```

- [ ] **Step 7: Run page test + the reports-page test**

Run: `npx vitest run client/src/pages/reports/platform-usage-page.test.tsx client/src/pages/reports/reports-page.test.tsx`
Expected: PASS.

- [ ] **Step 8: Typecheck client**

Run: `npm run typecheck --workspace=client` (or the repo's client typecheck script)
Expected: clean.

- [ ] **Step 9: Commit**

```bash
git add client/src/hooks/use-platform-usage-report.ts client/src/pages/reports/platform-usage-page.tsx client/src/App.tsx client/src/pages/reports/reports-page.tsx client/src/pages/reports/platform-usage-page.test.tsx
git commit -m "feat(usage): Platform Usage page + read hook + route + Reports card"
```

---

## Task 19: Wire byte-identical test to the real callers + full verification

**Files:**
- Modify: `server/src/modules/usage/byte-identical.test.ts`
- (verification only)

- [ ] **Step 1: Point the byte-identical test at the real live caller**

Replace the local `livePathCompute`/`rollupPathCompute` stand-ins in `byte-identical.test.ts` with the real fold both callers use — `computeUsageDaily` applied to the frozen `CLOSED_DAY` fixture exactly as `buildLiveDay` (read-service) and `rollupOfficeDay` (script) apply it. Since both production callers do `fetchRawUsageForDay(...) → computeUsageDaily(raw)`, the test feeds the same `raw` to `computeUsageDaily` twice and asserts equality — guarding that neither caller transforms `raw` before folding. Keep the closed-day fixture (do NOT use a live "today" snapshot).

- [ ] **Step 2: Run the full usage server test suite**

Run: `npx vitest run server/src/modules/usage server/tests/scripts/usage-rollup.runtime.test.ts server/tests/scripts/usage-raw-fetch.runtime.test.ts server/tests/scripts/usage-migration.runtime.test.ts server/tests/usage-route-registration.test.ts server/tests/usage-platform-usage-scope.test.ts server/tests/usage-drilldown-scope.test.ts`
Expected: all PASS.

- [ ] **Step 3: Run the full client usage test suite**

Run: `npx vitest run client/src/hooks/use-platform-usage-tracker.test.ts client/src/pages/reports/platform-usage-page.test.tsx client/src/components/layout/app-shell.test.tsx shared/src/schema/tenant/usage-schema.test.ts`
Expected: all PASS.

- [ ] **Step 4: Typecheck + build both workspaces**

Run: `npm run typecheck --workspace=server && npm run typecheck --workspace=client && npm run build --workspace=server`
Expected: clean.

- [ ] **Step 5: git diff --check**

Run: `git diff --check`
Expected: no whitespace errors.

- [ ] **Step 6: Commit**

```bash
git add server/src/modules/usage/byte-identical.test.ts
git commit -m "test(usage): wire byte-identical invariant to real callers; full suite green"
```

---

## Final verification checklist (run before opening a PR)

- [ ] `npx vitest run server/src/modules/usage server/tests/scripts/usage-*.runtime.test.ts server/tests/usage-*.test.ts` — all green
- [ ] `npx vitest run client/src/hooks/use-platform-usage-tracker.test.ts client/src/pages/reports/platform-usage-page.test.tsx client/src/components/layout/app-shell.test.tsx` — all green
- [ ] `npm run typecheck --workspace=server` and `--workspace=client` — clean
- [ ] `npm run build --workspace=server` — clean
- [ ] Migration 0157 still the highest-numbered migration (no collision landed since) — `ls migrations | tail -3`
- [ ] Ops: Railway nightly cron for `npm run usage:rollup` scheduled (out-of-repo runbook entry)
- [ ] Manual smoke (optional, via `/run` or browser): open the app, navigate a few records, confirm `usage_session`/`usage_heartbeat`/`usage_view_event` rows appear in `office_dallas`, then load `/reports/performance/platform-usage` and see yourself on the leaderboard.

---

## Spec coverage map

| Spec section | Task(s) |
|---|---|
| §3 Data model (4 tables, 14d retention, rolled_up_at) | 1, 2 |
| §4 Collection (session/heartbeat/views, server-stamped, sendBeacon) | 9, 10, 11, 16 |
| §5 Shared `computeUsageDaily` + constants + interval-merge + multi-source registry | 3, 4, 5, 6 |
| §5 byte-identical invariant (closed-day fixture) | 7, 19 |
| §6 Rollup (per-office fan-out) + live "today" | 13, 15 |
| §6 Retention prune gated on rollup | 15 |
| §7 API (summary + drilldown, server-enforced scoping) | 13, 14 |
| §8 Impersonation (session stamp + exclusion + documented caveat) | 6, 9 |
| §9 UI (page, daily/weekly, leaderboard "—" sort, caveat footnote) | 18 |
| §10 Tests (aggregate, registry contract, byte-identical, prune-gate, scoping ×2, fan-out, hook) | 4–7, 13–16, 19 |
