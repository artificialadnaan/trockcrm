import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { sql } from "drizzle-orm";
import { auditLog, dealHistory, deals } from "@trock-crm/shared/schema";
import { tenantSchemaSql } from "../../helpers/tenant-schema-from-drizzle.js";
import { setDealAwardedAmount } from "../../../src/modules/deals/service.js";

// The ROUTE tests mock the service, so every guard that actually protects the money lives here — run
// against a schema derived from the REAL Drizzle tables (so numeric(14,2) is genuinely numeric(14,2);
// a hand-rolled DDL would let the precision this file is about drift away from prod).

let tdb: any;
let pg: PGlite;
const U = (s: string) => `00000000-0000-4000-8000-${s.padStart(12, "0")}`;
const DEAL = U("11111");
const CO = U("22222");
const USER = U("33333");
// stage_id is NOT NULL with no default; the helper omits FKs, so any uuid stands in.
const STAGE = U("44444");

beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(tenantSchemaSql("public", [deals, dealHistory, auditLog]));
  tdb = drizzle(pg as any);
});

afterAll(async () => { await pg.close(); });

beforeEach(async () => {
  await pg.exec(`DELETE FROM deal_history; DELETE FROM audit_log; DELETE FROM deals;`);
  await tdb.insert(deals).values([
    { id: DEAL, stageId: STAGE, dealNumber: "D-1", name: "Deal", awardedAmount: "100.00", awardedAmountOverridden: false },
    { id: CO, stageId: STAGE, dealNumber: "D-2", name: "CO", awardedAmount: "-61828.57", isChangeOrder: true },
  ]);
});

const readDeal = async (id: string) => {
  const r: any = await tdb.execute(sql`SELECT awarded_amount, awarded_amount_overridden FROM deals WHERE id = ${id}`);
  return (r.rows ?? r)[0];
};

describe("setDealAwardedAmount", () => {
  it("sets the value and latches the manual override so the Bid Board mirror cannot revert it", async () => {
    await setDealAwardedAmount(tdb, DEAL, "439120.68", USER);
    const row = await readDeal(DEAL);

    expect(Number(row.awarded_amount)).toBeCloseTo(439120.68, 2);
    expect(row.awarded_amount_overridden).toBe(true);
  });

  // Deliberately writes NO deal_history row: DealHistoryTab renders stageHistory, and the only
  // application reader of deal_history filters for description changes — so a row here would look like
  // an audit trail while being unreachable. The audit_log entry is the real trail.
  it("does not write an unreachable deal_history row", async () => {
    await setDealAwardedAmount(tdb, DEAL, "439120.68", USER);
    const r: any = await tdb.execute(sql`SELECT count(*)::int AS n FROM deal_history WHERE deal_id = ${DEAL}`);

    expect((r.rows ?? r)[0].n).toBe(0);
  });

  it("records the change in the audit log, which IS surfaced", async () => {
    await setDealAwardedAmount(tdb, DEAL, "439120.68", USER);
    const r: any = await tdb.execute(sql`SELECT changes FROM audit_log WHERE record_id = ${DEAL}`);
    const rows = r.rows ?? r;

    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows[0].changes)).toContain("awardedAmount");
  });

  // THE TRAP: awarded_amount_overridden permanently freezes Bid Board sync for this column. A write that
  // changes nothing must never latch it.
  it.each(["100", "100.00", "100.001", "100.004"])(
    "treats %j as a no-op against a stored 100.00 and does NOT latch the override",
    async (value) => {
      await setDealAwardedAmount(tdb, DEAL, value, USER);
      const row = await readDeal(DEAL);

      expect(row.awarded_amount_overridden).toBe(false);
      const a: any = await tdb.execute(sql`SELECT count(*)::int AS n FROM audit_log WHERE record_id = ${DEAL}`);
      expect((a.rows ?? a)[0].n).toBe(0);
    }
  );

  it("still registers a change beyond the column's rounding", async () => {
    await setDealAwardedAmount(tdb, DEAL, "100.01", USER);
    const row = await readDeal(DEAL);

    expect(row.awarded_amount_overridden).toBe(true);
  });

  it("refuses a change-order child — its amount belongs to the change-order endpoints", async () => {
    await expect(setDealAwardedAmount(tdb, CO, "1000", USER)).rejects.toMatchObject({
      statusCode: 409,
      code: "CHANGE_ORDER_FIELD_LOCKED",
    });
    const row = await readDeal(CO);
    expect(Number(row.awarded_amount)).toBeCloseTo(-61828.57, 2);
  });

  it("returns null for a soft-deleted deal rather than mutating one the UI hides", async () => {
    await pg.exec(`UPDATE deals SET is_active = false WHERE id = '${DEAL}'`);

    await expect(setDealAwardedAmount(tdb, DEAL, "500", USER)).resolves.toBeNull();
    const row = await readDeal(DEAL);
    expect(Number(row.awarded_amount)).toBeCloseTo(100, 2);
  });

  it("clears the value on an explicit null", async () => {
    await setDealAwardedAmount(tdb, DEAL, null, USER);
    const row = await readDeal(DEAL);

    expect(row.awarded_amount).toBeNull();
    expect(row.awarded_amount_overridden).toBe(true);
  });
});
