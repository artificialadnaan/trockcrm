// Executes migration 0229 FROM DISK against a real Postgres (PGlite).
//
// 0229 widens `weekly_report_reminders_sent_kind_check` to admit `rep_escalation` — the 17:00 tier that
// tells the deal's sales rep a client report was never written.
//
// A CONSTRAINT-ONLY migration is the easiest kind to get wrong in a way nothing notices: the table still
// exists, every existing query still works, and the only symptom is that ONE new INSERT is rejected — by
// a job that catches per-office failures and carries on. So the escalation would simply never arrive,
// and the trace would be a log line nobody reads.
//
// The two halves are therefore proved APART, as with 0228:
//   1. The DO loop is proved by a second office schema, which the tenant block does not mention.
//   2. The TENANT block is proved by replaying it alone, with the loop never executed.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { migrationSql } from "../helpers/migration-sql.js";

const MIGRATION = "0229_weekly_report_rep_escalation_kind";
const KINDS = ["t_minus_2", "t_minus_1", "due_digest"] as const;

let pg: PGlite;

/** 0222's shape for this table, with the THREE-kind constraint 0229 is here to widen. */
async function seedOffices(schemas: string[]) {
  for (const schema of schemas) {
    await pg.exec(`
      CREATE SCHEMA IF NOT EXISTS ${schema};
      CREATE TABLE ${schema}.weekly_report_reminders_sent (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        weekly_report_project_id uuid NOT NULL DEFAULT gen_random_uuid(),
        week_of date NOT NULL DEFAULT '2026-08-13',
        kind varchar(20) NOT NULL,
        sent_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT weekly_report_reminders_sent_kind_check
          CHECK (kind IN ('t_minus_2', 't_minus_1', 'due_digest'))
      );
    `);
  }
}

function tenantBlock(): string {
  const raw = migrationSql(MIGRATION);
  const block = raw.split("-- TENANT_SCHEMA_START")[1]?.split("-- TENANT_SCHEMA_END")[0];
  expect(block, "TENANT_SCHEMA_START/END markers must be present").toBeTruthy();
  return block!;
}

async function insertKind(schema: string, kind: string): Promise<"ok" | "rejected"> {
  try {
    await pg.query(`INSERT INTO ${schema}.weekly_report_reminders_sent (kind) VALUES ($1)`, [kind]);
    return "ok";
  } catch {
    return "rejected";
  }
}

beforeEach(async () => {
  pg = new PGlite();
});

afterEach(async () => {
  // One in-memory Postgres per test, and nothing closed them — so every instance stayed live for the
  // whole file run. The sibling suites close theirs; this one did not.
  await pg.close();
});

describe("migration 0229 — rep_escalation reminder kind", () => {
  it("is REJECTED before the migration — the premise this whole file rests on", async () => {
    // Without this the assertions below could pass against a table that never constrained anything,
    // and the migration would be proving nothing at all.
    await seedOffices(["office_dallas"]);
    expect(await insertKind("office_dallas", "rep_escalation")).toBe("rejected");
  });

  it("admits rep_escalation in EVERY office schema, not just Dallas", async () => {
    await seedOffices(["office_dallas", "office_atlanta"]);
    await pg.exec(migrationSql(MIGRATION));

    for (const schema of ["office_dallas", "office_atlanta"]) {
      expect(await insertKind(schema, "rep_escalation"), schema).toBe("ok");
    }
  });

  it("has a TENANT_SCHEMA block that widens the constraint on its own", async () => {
    // Replayed ALONE, with the loop never run. A newly provisioned office gets this block and nothing
    // else, and without it the first escalation there fails on a CHECK the job swallows.
    await seedOffices(["office_dallas"]);
    expect(await insertKind("office_dallas", "rep_escalation")).toBe("rejected");

    await pg.exec(tenantBlock());

    expect(await insertKind("office_dallas", "rep_escalation")).toBe("ok");
  });

  it("still rejects a kind that is not in the list, in EVERY office", async () => {
    // The constraint has to keep CONSTRAINING, and this has to be checked somewhere the TENANT block
    // does not reach.
    //
    // The first version of this test only looked at office_dallas, and it did not fire: deleting the
    // loop's ADD leaves the constraint dropped for every office, but the tenant block at the bottom of
    // the file re-adds it for DALLAS specifically — so Dallas looked correct while Atlanta silently
    // accepted anything at all. The neighbouring "admits rep_escalation in EVERY office" test could not
    // catch it either, because a table with NO constraint admits `rep_escalation` most obligingly.
    //
    // Asserting a REJECTION in a non-Dallas office is the only assertion here that distinguishes
    // "widened" from "removed".
    await seedOffices(["office_dallas", "office_atlanta"]);
    await pg.exec(migrationSql(MIGRATION));

    expect(await insertKind("office_dallas", "not_a_real_kind")).toBe("rejected");
    expect(await insertKind("office_atlanta", "not_a_real_kind")).toBe("rejected");
  });

  it("keeps admitting the three kinds that already existed", async () => {
    await seedOffices(["office_dallas"]);
    await pg.exec(migrationSql(MIGRATION));

    for (const kind of KINDS) {
      expect(await insertKind("office_dallas", kind), kind).toBe("ok");
    }
  });

  it("preserves the rows already claimed, so no reminder re-sends", async () => {
    // DROP + ADD rewrites the constraint, not the data — but a constraint migration that lost rows
    // would make every already-sent reminder eligible again, and the whole office would be re-nudged.
    await seedOffices(["office_dallas"]);
    await pg.exec(
      `INSERT INTO office_dallas.weekly_report_reminders_sent (kind) VALUES ('t_minus_2'), ('due_digest')`,
    );

    await pg.exec(migrationSql(MIGRATION));

    const rows = await pg.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM office_dallas.weekly_report_reminders_sent`,
    );
    expect(rows.rows[0]?.n).toBe("2");
  });

  it("skips an office that has no reminders table instead of aborting the migration", async () => {
    await seedOffices(["office_dallas"]);
    await pg.exec(`CREATE SCHEMA office_legacy;`);

    await expect(pg.exec(migrationSql(MIGRATION))).resolves.toBeDefined();
    expect(await insertKind("office_dallas", "rep_escalation")).toBe("ok");
  });

  it("is idempotent — re-running changes nothing and does not error", async () => {
    await seedOffices(["office_dallas"]);
    await pg.exec(migrationSql(MIGRATION));
    await expect(pg.exec(migrationSql(MIGRATION))).resolves.toBeDefined();

    expect(await insertKind("office_dallas", "rep_escalation")).toBe("ok");
    expect(await insertKind("office_dallas", "not_a_real_kind")).toBe("rejected");
  });
});
