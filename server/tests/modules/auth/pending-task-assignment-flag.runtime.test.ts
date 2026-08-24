// REAL-SQL (PGlite) proof for the boolean that rides every auth response.
//
// C6 — "it is one boolean" hides real work. `app.use("/api/auth", authRoutes)` is mounted BEFORE the
// tenant router, so nothing under auth/ has a `tenantDb`, and the acknowledgement table is per-office.
// This mirrors getUserOnboardingGateStatus: resolve the office slug out of public.offices, guard the
// schema with to_regclass, then query it by name. That guard is not decoration — during the deploy
// window between the API migrating and an office being provisioned, the table genuinely is not there,
// and an unguarded query 42P01s inside the login path.
//
// C11 — asserting only that the key EXISTS is green the moment somebody hardcodes `false`. So the
// transitions are what is asserted: true with a pending assignment, false once it is acknowledged, and
// true again for the urgent/overdue rows the repeat rule keeps alive. The flag has to agree with the
// modal's own query exactly, or a user gets a modal that opens onto nothing (flag too broad) or an
// urgent repeat that never fires (flag too narrow).
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PGlite } from "@electric-sql/pglite";

const OFFICE_ID = "0f1ce000-0000-0000-0000-000000000001";
const ALICE = "aaaaaaaa-0000-0000-0000-00000000a11c";
const BOB = "bbbbbbbb-0000-0000-0000-00000000b0b0";
const SCHEMA = "office_dallas";

let pg: PGlite;

// The auth service reads through `pool` (node-postgres) rather than a tenant Drizzle handle, so the
// module's own db import is what gets swapped for PGlite. `pool.query(text, params)` and
// `PGlite.query(text, params)` agree on both the call shape and the `{ rows }` result shape.
vi.mock("../../../src/db.js", () => ({
  pool: {
    query: (text: string, params?: unknown[]) => pg.query(text, params as any[]),
  },
  db: {},
  releasePooledClient: vi.fn(),
  isBrokenConnectionError: () => false,
}));

const { userHasPendingTaskAssignments } = await import("../../../src/modules/auth/service.js");

function todayCt() {
  return new Date().toLocaleDateString("en-CA", { timeZone: "America/Chicago" });
}

function shiftDays(iso: string, n: number): string {
  const [y, m, d] = iso.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + n);
  return dt.toISOString().slice(0, 10);
}

async function seedTask(overrides: {
  id: string;
  priority?: string;
  status?: string;
  assignedTo?: string;
  dueDate?: string | null;
  source?: string;
  isTestData?: boolean;
}) {
  await pg.query(
    `INSERT INTO ${SCHEMA}.tasks (id, title, priority, status, assigned_to, due_date, source, is_test_data)
     VALUES ($1, 'seeded', $2, $3, $4, $5, $6, $7)`,
    [
      overrides.id,
      overrides.priority ?? "normal",
      overrides.status ?? "pending",
      overrides.assignedTo ?? ALICE,
      overrides.dueDate ?? null,
      overrides.source ?? "manual",
      overrides.isTestData ?? false,
    ]
  );
}

async function ack(taskId: string, userId: string) {
  await pg.query(
    `INSERT INTO ${SCHEMA}.task_assignment_acknowledgements (task_id, user_id) VALUES ($1, $2)`,
    [taskId, userId]
  );
}

beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(`
    CREATE SCHEMA IF NOT EXISTS public;
    CREATE TABLE public.offices (id uuid PRIMARY KEY, slug varchar(50) NOT NULL);
    INSERT INTO public.offices (id, slug) VALUES ('${OFFICE_ID}', 'dallas');

    CREATE SCHEMA IF NOT EXISTS ${SCHEMA};
    CREATE TABLE ${SCHEMA}.tasks (
      id uuid PRIMARY KEY,
      title varchar(500) NOT NULL,
      priority varchar(20) NOT NULL DEFAULT 'normal',
      status varchar(20) NOT NULL DEFAULT 'pending',
      assigned_to uuid NOT NULL,
      created_by uuid,
      due_date date,
      source varchar(20) NOT NULL DEFAULT 'automated',
      is_test_data boolean NOT NULL DEFAULT false
    );
    CREATE TABLE ${SCHEMA}.task_assignment_acknowledgements (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      task_id uuid NOT NULL REFERENCES ${SCHEMA}.tasks(id) ON DELETE CASCADE,
      user_id uuid NOT NULL,
      acknowledged_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT task_assignment_ack_uq UNIQUE (task_id, user_id)
    );
  `);
});

afterAll(async () => {
  await pg.close();
});

beforeEach(async () => {
  await pg.exec(`DELETE FROM ${SCHEMA}.task_assignment_acknowledgements; DELETE FROM ${SCHEMA}.tasks;`);
});

const forAlice = { userId: ALICE, officeId: OFFICE_ID };

describe("userHasPendingTaskAssignments", () => {
  it("is FALSE when the person has nothing waiting", async () => {
    expect(await userHasPendingTaskAssignments(forAlice)).toBe(false);
  });

  it("is TRUE for an unacknowledged manual assignment", async () => {
    await seedTask({ id: "11111111-0000-0000-0000-000000000001" });

    expect(await userHasPendingTaskAssignments(forAlice)).toBe(true);
  });

  it("flips to FALSE once that assignment is acknowledged", async () => {
    await seedTask({ id: "11111111-0000-0000-0000-000000000001" });
    expect(await userHasPendingTaskAssignments(forAlice)).toBe(true);

    await ack("11111111-0000-0000-0000-000000000001", ALICE);

    expect(await userHasPendingTaskAssignments(forAlice)).toBe(false);
  });

  it("STAYS TRUE for an acknowledged urgent assignment — the repeat rule", async () => {
    await seedTask({ id: "11111111-0000-0000-0000-000000000001", priority: "urgent" });
    await ack("11111111-0000-0000-0000-000000000001", ALICE);

    expect(await userHasPendingTaskAssignments(forAlice)).toBe(true);
  });

  it("STAYS TRUE for an acknowledged OVERDUE assignment", async () => {
    await seedTask({
      id: "11111111-0000-0000-0000-000000000001",
      priority: "low",
      dueDate: shiftDays(todayCt(), -3),
    });
    await ack("11111111-0000-0000-0000-000000000001", ALICE);

    expect(await userHasPendingTaskAssignments(forAlice)).toBe(true);
  });

  it("ignores automated tasks, completed tasks, demo rows and other people's work", async () => {
    await seedTask({ id: "11111111-0000-0000-0000-000000000001", source: "automated", priority: "urgent" });
    await seedTask({ id: "11111111-0000-0000-0000-000000000002", status: "completed" });
    await seedTask({ id: "11111111-0000-0000-0000-000000000003", isTestData: true });
    await seedTask({ id: "11111111-0000-0000-0000-000000000004", assignedTo: BOB });

    expect(await userHasPendingTaskAssignments(forAlice)).toBe(false);
    // ...and Bob, who owns exactly one of those, does have something waiting.
    expect(await userHasPendingTaskAssignments({ userId: BOB, officeId: OFFICE_ID })).toBe(true);
  });

  it("is FALSE, not an exception, for an office schema that has not been provisioned yet", async () => {
    await pg.query(`INSERT INTO public.offices (id, slug) VALUES ($1, 'tulsa')`, [
      "0f1ce000-0000-0000-0000-000000000002",
    ]);

    expect(
      await userHasPendingTaskAssignments({ userId: ALICE, officeId: "0f1ce000-0000-0000-0000-000000000002" })
    ).toBe(false);
  });

  it("is FALSE, not an exception, for an office id that does not exist", async () => {
    expect(
      await userHasPendingTaskAssignments({ userId: ALICE, officeId: "0f1ce000-0000-0000-0000-0000000000ff" })
    ).toBe(false);
  });

  // Failing OPEN here is deliberate and is the opposite of getUserOnboardingGateStatus, which fails
  // CLOSED. That gate withholds the app until cleanup is done, so its safe answer is "blocked". This
  // one INTERRUPTS somebody, so its safe answer is "don't". A DB hiccup must not manufacture a modal.
  it("is FALSE, not an exception, when the query itself fails", async () => {
    await pg.exec(`ALTER TABLE ${SCHEMA}.tasks RENAME COLUMN source TO source_moved;`);
    try {
      expect(await userHasPendingTaskAssignments(forAlice)).toBe(false);
    } finally {
      await pg.exec(`ALTER TABLE ${SCHEMA}.tasks RENAME COLUMN source_moved TO source;`);
    }
  });
});
