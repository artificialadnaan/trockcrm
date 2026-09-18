// Executes migration 0238 FROM DISK against a real Postgres (PGlite).
//
// 0238 seeds the `notification_recipient_groups` rows for the two keys this PR adds to the registry, so a
// job reading one of them can tell "nobody configured this" from "configured to nobody" instead of getting
// the same empty list either way.
//
// WHY THIS NEEDS A REAL DATABASE. The file is one INSERT, and the only interesting thing about it is what
// happens when the row is ALREADY THERE. #1106 is stacked on this branch and its 0232 creates the
// `marketing_expense_approver` row too, with `ON CONFLICT DO NOTHING`, plus an assignment row this file
// does not touch. The runner sorts by filename and skips only what it has already executed, so BOTH orders
// are reachable in the field: 0232-then-0238 in a merged tree, and 0238-then-0232 on a database that
// deployed this PR before #1106 landed. "It should be idempotent, it has an ON CONFLICT" is a reading of
// the SQL, not a test of it — and a clobbered assignment row is silent.
//
// The other branch's SQL is deliberately NOT transcribed here. What is asserted is the INVARIANT — a row
// for this key may already exist, with or without assignments hanging off it — which stays true however
// #1106's file is eventually written.

import { beforeEach, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { NOTIFICATION_RECIPIENT_GROUPS } from "@trock-crm/shared/types";
import { migrationSql } from "../helpers/migration-sql.js";

const MIGRATION = "0238_notification_recipient_groups_registry";
const KEY = "marketing_expense_approver";

let pg: PGlite;

async function runMigration() {
  await pg.exec(migrationSql(MIGRATION));
}

async function groupRows() {
  const { rows } = await pg.query<{ key: string; name: string; description: string }>(
    "SELECT key, name, description FROM public.notification_recipient_groups ORDER BY key"
  );
  return rows;
}

beforeEach(async () => {
  pg = new PGlite();
  // 0079's shape — the table this migration inserts into, plus the users table its FK points at.
  await pg.exec(`
    CREATE TABLE public.users (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      email text NOT NULL UNIQUE
    );
    CREATE TABLE public.notification_recipient_groups (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      key text NOT NULL UNIQUE,
      name text NOT NULL,
      description text,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE public.notification_recipient_assignments (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      group_id uuid NOT NULL REFERENCES public.notification_recipient_groups(id) ON DELETE CASCADE,
      user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
      created_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (group_id, user_id)
    );
    INSERT INTO public.users (email) VALUES ('tyamashita@trockgc.com');
  `);
});

describe("migration 0238", () => {
  it("creates a row for every key the registry names but 0079 did not", async () => {
    await runMigration();

    const seeded = await groupRows();
    expect(seeded.map((row) => row.key)).toEqual(["bid_due_date_report", KEY]);
  });

  it("seeds exactly the name and description the registry declares", async () => {
    // The registry is what the admin page renders and what `ensureWellKnownGroup` would lazily create.
    // A migration that seeds different text produces a row that disagrees with the code that reads it.
    await runMigration();

    for (const row of await groupRows()) {
      const definition = NOTIFICATION_RECIPIENT_GROUPS.find((group) => group.key === row.key)!;
      expect(row.name).toBe(definition.name);
      expect(row.description).toBe(definition.description);
    }
  });

  it("is idempotent — running it twice leaves one row per key", async () => {
    await runMigration();
    await runMigration();

    const seeded = await groupRows();
    expect(seeded).toHaveLength(2);
  });

  it("leaves an earlier migration's row and its ASSIGNMENTS alone (0232 then 0238)", async () => {
    // #1106's order. Its 0232 creates the group and assigns Takashi to it; a submit path resolves that
    // assignment inside a transaction and 409s when it comes back empty, so dropping it would turn every
    // marketing expense submit into a blocked one.
    await pg.exec(`
      INSERT INTO public.notification_recipient_groups (key, name, description)
      VALUES ('${KEY}', 'Marketing Expense Approver', 'Approves marketing and advertising expense requests.');
      INSERT INTO public.notification_recipient_assignments (group_id, user_id)
      SELECT g.id, u.id FROM public.notification_recipient_groups g, public.users u WHERE g.key = '${KEY}';
    `);
    const { rows: before } = await pg.query<{ id: string }>(
      `SELECT id FROM public.notification_recipient_groups WHERE key = '${KEY}'`
    );

    await runMigration();

    const { rows: after } = await pg.query<{ id: string; assignments: number }>(`
      SELECT g.id, count(a.id)::int AS assignments
      FROM public.notification_recipient_groups g
      LEFT JOIN public.notification_recipient_assignments a ON a.group_id = g.id
      WHERE g.key = '${KEY}'
      GROUP BY g.id
    `);
    // Same row, not a replacement: a new id would have cascaded the assignment away.
    expect(after).toHaveLength(1);
    expect(after[0].id).toBe(before[0].id);
    expect(after[0].assignments).toBe(1);
  });

  it("survives a later DO NOTHING insert of the same key (0238 then 0232)", async () => {
    // The other order, reachable on any database that deployed this PR before #1106 merged.
    await runMigration();
    const { rows: before } = await pg.query<{ id: string }>(
      `SELECT id FROM public.notification_recipient_groups WHERE key = '${KEY}'`
    );

    await pg.exec(`
      INSERT INTO public.notification_recipient_groups (key, name, description)
      VALUES ('${KEY}', 'Marketing Expense Approver', 'Approves marketing and advertising expense requests.')
      ON CONFLICT (key) DO NOTHING;
      INSERT INTO public.notification_recipient_assignments (group_id, user_id)
      SELECT g.id, u.id FROM public.notification_recipient_groups g, public.users u WHERE g.key = '${KEY}'
      ON CONFLICT (group_id, user_id) DO NOTHING;
    `);

    const { rows: after } = await pg.query<{ id: string }>(
      `SELECT id FROM public.notification_recipient_groups WHERE key = '${KEY}'`
    );
    expect(after).toHaveLength(1);
    expect(after[0].id).toBe(before[0].id);
  });

  it("converges a row whose text has drifted back onto the registry", async () => {
    // The DO UPDATE, stated as a decision rather than left as a side effect: whatever text a row was
    // created with, the registry is the version the application reads.
    await pg.exec(`
      INSERT INTO public.notification_recipient_groups (key, name, description)
      VALUES ('${KEY}', 'Stale Name', 'Stale description.');
    `);

    await runMigration();

    const row = (await groupRows()).find((candidate) => candidate.key === KEY)!;
    expect(row.name).toBe("Marketing Expense Approver");
  });
});
