import { readFileSync } from "fs";
import { resolve } from "path";
import { describe, expect, it } from "vitest";

describe("0111_lead_dd_recipient_reseed migration", () => {
  const migrationSql = readFileSync(
    resolve(import.meta.dirname, "../../../../migrations/0111_lead_dd_recipient_reseed.sql"),
    "utf8"
  );

  // Static SQL contract — the migration must encode idempotency directly,
  // not rely on the runner to track applied state. This pin prevents a
  // future edit from dropping the ON CONFLICT clauses (which is exactly
  // how migration 0079's seed silently broke in production: the row was
  // recorded as applied but the INSERT never persisted, and the migration
  // body had no idempotent recovery path).
  it("declares the seed INSERT with ON CONFLICT DO NOTHING on the unique key", () => {
    expect(migrationSql).toMatch(/INSERT INTO public\.notification_recipient_groups/);
    expect(migrationSql).toMatch(/'lead_due_diligence'/);
    expect(migrationSql).toMatch(/ON CONFLICT \(key\) DO NOTHING/);
  });

  it("re-seeds the assignment join rows with ON CONFLICT DO NOTHING on the (group_id, user_id) pair", () => {
    expect(migrationSql).toMatch(/INSERT INTO public\.notification_recipient_assignments/);
    expect(migrationSql).toMatch(/ON CONFLICT \(group_id, user_id\) DO NOTHING/);
  });

  it("never inserts hard-coded user ids; resolves recipients via JOIN on users.email", () => {
    // The seed restores the same two users (tyamashita + adnaan.iqbal) the
    // original 0079 / 0081 seed targeted, but it does so by joining on
    // lower(email). That keeps the migration safe to run against any
    // environment where those users may or may not exist — missing users
    // simply produce zero rows from the SELECT, and the INSERT no-ops.
    expect(migrationSql).toMatch(/FROM public\.notification_recipient_groups g/);
    expect(migrationSql).toMatch(/JOIN public\.users u/);
    expect(migrationSql).toMatch(/lower\(u\.email\)/);
    expect(migrationSql).not.toMatch(/VALUES\s*\(\s*'[0-9a-fA-F-]{36}'/);
  });

  it("simulates a double-apply: first run inserts, second run is a no-op", () => {
    // The migration runner already skips re-applied migrations, so the
    // SQL-level idempotency is a belt-and-suspenders defense for ops
    // scenarios where the runner ledger is rewound (DB restore, schema
    // promotion, etc.). Simulate that scenario in-memory.
    type GroupRow = { id: string; key: string; name: string; description: string };
    type AssignmentRow = { groupId: string; userId: string };

    const groups: GroupRow[] = [];
    const assignments: AssignmentRow[] = [];
    const users = [
      { id: "user-1", email: "tyamashita@trockgc.com" },
      { id: "user-2", email: "adnaan.iqbal@gmail.com" },
    ];

    function applyMigration() {
      // INSERT INTO notification_recipient_groups ... ON CONFLICT (key) DO NOTHING
      if (!groups.some((g) => g.key === "lead_due_diligence")) {
        groups.push({
          id: `group-${groups.length + 1}`,
          key: "lead_due_diligence",
          name: "Lead Due Diligence",
          description: "Recipients who receive new-customer lead due diligence approval requests.",
        });
      }
      const group = groups.find((g) => g.key === "lead_due_diligence");
      if (!group) return;
      // INSERT INTO assignments SELECT g.id, u.id ... ON CONFLICT (group_id, user_id) DO NOTHING
      for (const u of users) {
        if (
          !assignments.some(
            (a) => a.groupId === group.id && a.userId === u.id
          )
        ) {
          assignments.push({ groupId: group.id, userId: u.id });
        }
      }
    }

    applyMigration();
    const groupsAfterFirstRun = [...groups];
    const assignmentsAfterFirstRun = [...assignments];

    applyMigration();
    applyMigration();

    expect(groups).toEqual(groupsAfterFirstRun);
    expect(assignments).toEqual(assignmentsAfterFirstRun);
    expect(groups).toHaveLength(1);
    expect(assignments).toHaveLength(2);
  });
});
