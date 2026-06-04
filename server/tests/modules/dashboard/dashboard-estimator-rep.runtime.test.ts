import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { buildRepContractsSignedSql } from "../../../src/modules/dashboard/service.js";

/**
 * REAL-SQL (PGlite) proof that the rep dashboard's contracts-signed YTD/MTD card is estimator-aware
 * (PR 2): it now counts contracts on deals the person ESTIMATED, not only ones they own. It is a
 * count + awarded-value KPI for the single rep (no commission rate applied, no per-rep grouping), so
 * estimator-awareness scopes the view to the person's involved deals without misattribution or
 * commission-math impact. (getRepPotentialRevenue stays assigned-only — it feeds a flat-rate commission
 * projection, so estimator-awareness would price deals the rep doesn't own at the wrong rate.)
 */
const U = (s: string) => `00000000-0000-0000-0000-${s.padStart(12, "0")}`;
const REP_A = U("a01"); // owner
const REP_B = U("b01"); // estimator-only
const REP_C = U("c01"); // uninvolved
const ST = U("57001");
const D = { signedEstB: U("d02") };

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let tdb: any;
let pg: PGlite;

beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(`
    CREATE TABLE pipeline_stage_config (id uuid PRIMARY KEY, slug text UNIQUE NOT NULL);
    CREATE TABLE deals (
      id uuid PRIMARY KEY, assigned_rep_id uuid, estimator_user_id uuid, stage_id uuid NOT NULL,
      is_active boolean NOT NULL DEFAULT true, is_test_data boolean NOT NULL DEFAULT false,
      on_hold boolean NOT NULL DEFAULT false, contract_signed_at timestamptz, contract_signed_date date,
      awarded_amount numeric
    );
    INSERT INTO pipeline_stage_config (id, slug) VALUES ('${ST}', 'opportunity');
    -- signed deal, assigned A but estimated by B -> counts toward B's contracts-signed YTD (estimator-aware)
    INSERT INTO deals (id, assigned_rep_id, estimator_user_id, stage_id, contract_signed_at, awarded_amount) VALUES
      ('${D.signedEstB}', '${REP_A}', '${REP_B}', '${ST}', '2026-03-15T00:00:00Z', 50000);
  `);
  tdb = drizzle(pg);
});
afterAll(async () => {
  await pg?.close?.();
});

describe("buildRepContractsSignedSql is estimator-aware", () => {
  const run = (uid: string) =>
    tdb.execute(buildRepContractsSignedSql(uid, "2026-01-01", "2026-06-01", "2026-06-04"))
      .then((r: unknown) => ((r as { rows?: unknown[] })?.rows ?? r) as Array<Record<string, unknown>>);

  it("counts a contract the rep ESTIMATED (owned by someone else) in YTD", async () => {
    const [row] = await run(REP_B);
    expect(Number(row.ytd_count)).toBe(1);
    expect(Number(row.ytd_value)).toBe(50000);
  });
  it("the owner is unchanged", async () => {
    const [row] = await run(REP_A);
    expect(Number(row.ytd_count)).toBe(1);
  });
  it("an uninvolved person has no signed contracts", async () => {
    const [row] = await run(REP_C);
    expect(Number(row.ytd_count)).toBe(0);
  });
});
