import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { sql, type SQL } from "drizzle-orm";
import { buildOwnerScopeSql } from "../../../src/modules/reports/analytics-tier4-service.js";

/**
 * REAL-SQL (PGlite) integration guard for the estimator-aware owner filter (PR 2) on analytics-tier4.
 * analytics-tier4's owner filter previously matched the assigned rep only; now it matches the resolved
 * estimator too, so a person's analytics report surfaces deals they ESTIMATED. This covers BOTH supported
 * filter paths: by uuid (`ownerIds`, the id-IN-list estimator-OR) AND by name (`ownerNames`, the assigned
 * rep's name OR an estimator-name subquery — Codex P2). The consuming queries LEFT JOIN users on the
 * ASSIGNED rep, so the test mirrors that join; an unassigned-but-estimated deal still surfaces.
 * analytics-tier4 is the only multi-rep owner-filter tier that stays estimator-aware — its outputs are
 * keyed by vertical/region/company/period, never by the assigned rep, so it cannot misattribute.
 */
const U = (s: string) => `00000000-0000-0000-0000-${s.padStart(12, "0")}`;
const REP_A = U("a01");
const REP_B = U("b01");
const D = {
  ownA: U("d01"),
  ownB: U("d02"),
  ownA_estB: U("d03"), // assigned A, estimated by B
  estB_unassigned: U("d04"), // assigned NULL, estimated by B
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let tdb: any;
let pg: PGlite;
// Mirror analytics-tier4's query shape: deals LEFT JOIN users u ON u.id = d.assigned_rep_id.
function ids(clause: SQL): Promise<string[]> {
  return tdb
    .execute(sql`SELECT d.id::text AS id FROM deals d LEFT JOIN users u ON u.id = d.assigned_rep_id WHERE ${clause} ORDER BY d.id`)
    .then((r: unknown) =>
      ((Array.isArray(r) ? r : (r as { rows?: unknown[] })?.rows ?? []) as Array<{ id: string }>).map((x) => x.id)
    );
}

beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(`
    CREATE TABLE users (id uuid PRIMARY KEY, display_name text);
    CREATE TABLE deals (id uuid PRIMARY KEY, assigned_rep_id uuid, estimator_user_id uuid, sales_source_user_id uuid);
    INSERT INTO users (id, display_name) VALUES ('${REP_A}','Alice'), ('${REP_B}','Bob');
    INSERT INTO deals (id, assigned_rep_id, estimator_user_id) VALUES
      ('${D.ownA}', '${REP_A}', NULL),
      ('${D.ownB}', '${REP_B}', NULL),
      ('${D.ownA_estB}', '${REP_A}', '${REP_B}'),
      ('${D.estB_unassigned}', NULL, '${REP_B}');
  `);
  tdb = drizzle(pg);
});
afterAll(async () => {
  await pg?.close?.();
});

// buildOwnerScopeSql carries a leading AND for interpolation; anchor it with TRUE.
const scope = (ownerIds: string[], ownerNames: string[]) => sql`TRUE ${buildOwnerScopeSql({ ownerIds, ownerNames })}`;

describe("analytics-tier4 buildOwnerScopeSql — by uuid (ownerIds, cast value/::uuid)", () => {
  it("filtering by [B] surfaces deals B owns AND deals B estimated (incl. unassigned)", async () => {
    const rows = await ids(scope([REP_B], []));
    expect(rows).toEqual([D.ownB, D.ownA_estB, D.estB_unassigned].sort());
  });
  it("a team list [A,B] surfaces every deal either owns or estimated", async () => {
    const rows = await ids(scope([REP_A, REP_B], []));
    expect(rows).toEqual([D.ownA, D.ownB, D.ownA_estB, D.estB_unassigned].sort());
  });
});

describe("analytics-tier4 buildOwnerScopeSql — by name (ownerNames, estimator-aware via subquery)", () => {
  it("filtering by name ['Bob'] surfaces deals Bob owns AND deals Bob estimated (incl. unassigned)", async () => {
    const rows = await ids(scope([], ["Bob"]));
    expect(rows).toEqual([D.ownB, D.ownA_estB, D.estB_unassigned].sort());
  });
  it("filtering by name ['Alice'] surfaces only deals Alice owns (she estimated none)", async () => {
    const rows = await ids(scope([], ["Alice"]));
    expect(rows).toEqual([D.ownA, D.ownA_estB].sort());
  });
  it("no owner scope does not narrow", async () => {
    const rows = await ids(scope([], []));
    expect(rows).toEqual([D.ownA, D.ownB, D.ownA_estB, D.estB_unassigned].sort());
  });
});
