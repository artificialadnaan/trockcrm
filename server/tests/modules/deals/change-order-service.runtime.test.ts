import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import {
  addDealChangeOrder,
  assertDealEligibleForChangeOrder,
  deleteDealChangeOrder,
  getDealChangeOrderById,
  listDealChangeOrders,
  normalizeChangeOrderAmount,
  sumDealChangeOrders,
  updateDealChangeOrder,
} from "../../../src/modules/deals/change-order-service.js";

/**
 * REAL-SQL (PGlite) guard for the CRM change-order service: eligibility (Won-family OR
 * Bid-Board-Owned), positive-amount enforcement, CRUD, and the deal CO sum. Tables live in the
 * default (public) schema so Drizzle's unqualified table refs resolve, exactly as prod resolves
 * them via the per-office search_path.
 */
const U = (s: string) => `00000000-0000-0000-0000-${s.padStart(12, "0")}`;
const USER = U("99");
const WON_STAGE = U("a1");
const ESTIMATING_STAGE = U("a2");
const OPP_STAGE = U("a3");
const DEAL_WON = U("d01");
const DEAL_BBO = U("d02"); // bid-board-owned, NOT won
const DEAL_PLAIN = U("d03"); // not won, not bid-board-owned -> ineligible

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let tdb: any;
let pg: PGlite;

beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(`
    CREATE TABLE public.users (id uuid PRIMARY KEY);
    CREATE TABLE pipeline_stage_config (id uuid PRIMARY KEY, slug varchar(100) NOT NULL);
    CREATE TABLE deals (
      id uuid PRIMARY KEY,
      stage_id uuid NOT NULL,
      workflow_route text NOT NULL DEFAULT 'normal',
      is_bid_board_owned boolean NOT NULL DEFAULT false,
      awarded_amount numeric(14,2)
    );
    CREATE TABLE deal_change_orders (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      deal_id uuid NOT NULL REFERENCES deals(id) ON DELETE CASCADE,
      signed_date date NOT NULL,
      amount numeric(14,2) NOT NULL CHECK (amount > 0),
      description text,
      created_by uuid REFERENCES public.users(id) ON DELETE SET NULL,
      updated_by uuid REFERENCES public.users(id) ON DELETE SET NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    INSERT INTO public.users (id) VALUES ('${USER}');
    INSERT INTO pipeline_stage_config (id, slug) VALUES
      ('${WON_STAGE}', 'won'),
      ('${ESTIMATING_STAGE}', 'estimating'),
      ('${OPP_STAGE}', 'opportunity');
    INSERT INTO deals (id, stage_id, workflow_route, is_bid_board_owned, awarded_amount) VALUES
      ('${DEAL_WON}', '${WON_STAGE}', 'normal', false, 100000.00),
      ('${DEAL_BBO}', '${ESTIMATING_STAGE}', 'normal', true, 50000.00),
      ('${DEAL_PLAIN}', '${OPP_STAGE}', 'normal', false, NULL);
  `);
  tdb = drizzle(pg);
});

afterAll(async () => {
  await pg?.close?.();
});

beforeEach(async () => {
  await pg.exec(`DELETE FROM deal_change_orders;`);
});

describe("normalizeChangeOrderAmount", () => {
  it("accepts a positive number/string and normalizes to 2 decimals", () => {
    expect(normalizeChangeOrderAmount(1500)).toBe("1500.00");
    expect(normalizeChangeOrderAmount("250.5")).toBe("250.50");
  });
  it("rejects zero, negative, and non-numeric", () => {
    expect(() => normalizeChangeOrderAmount(0)).toThrow();
    expect(() => normalizeChangeOrderAmount(-5)).toThrow();
    expect(() => normalizeChangeOrderAmount("abc")).toThrow();
    expect(() => normalizeChangeOrderAmount(null)).toThrow();
  });
});

describe("assertDealEligibleForChangeOrder", () => {
  it("allows a Won deal", async () => {
    await expect(assertDealEligibleForChangeOrder(tdb, DEAL_WON)).resolves.toBeTruthy();
  });
  it("allows a Bid-Board-Owned deal even when not Won", async () => {
    await expect(assertDealEligibleForChangeOrder(tdb, DEAL_BBO)).resolves.toBeTruthy();
  });
  it("rejects a non-Won, non-Bid-Board-Owned deal", async () => {
    await expect(assertDealEligibleForChangeOrder(tdb, DEAL_PLAIN)).rejects.toMatchObject({
      statusCode: 409,
    });
  });
  it("404s for a missing deal", async () => {
    await expect(assertDealEligibleForChangeOrder(tdb, U("dead"))).rejects.toMatchObject({
      statusCode: 404,
    });
  });
});

describe("addDealChangeOrder", () => {
  it("adds a change order to a Won deal", async () => {
    const co = await addDealChangeOrder(tdb, {
      dealId: DEAL_WON,
      signedDate: "2026-03-15",
      amount: "1500",
      description: "  extra flashing  ",
      createdBy: USER,
    });
    expect(co.dealId).toBe(DEAL_WON);
    expect(Number(co.amount)).toBe(1500);
    expect(co.signedDate).toBe("2026-03-15");
    expect(co.description).toBe("extra flashing");
    expect(co.createdBy).toBe(USER);
  });
  it("adds a change order to a Bid-Board-Owned deal", async () => {
    const co = await addDealChangeOrder(tdb, {
      dealId: DEAL_BBO,
      signedDate: "2026-04-01",
      amount: 999.99,
      createdBy: USER,
    });
    expect(Number(co.amount)).toBe(999.99);
  });
  it("refuses to add a change order to an ineligible deal", async () => {
    await expect(
      addDealChangeOrder(tdb, { dealId: DEAL_PLAIN, signedDate: "2026-03-15", amount: 100, createdBy: USER }),
    ).rejects.toMatchObject({ statusCode: 409 });
    expect((await listDealChangeOrders(tdb, DEAL_PLAIN)).length).toBe(0);
  });
  it("rejects a non-positive amount", async () => {
    await expect(
      addDealChangeOrder(tdb, { dealId: DEAL_WON, signedDate: "2026-03-15", amount: 0, createdBy: USER }),
    ).rejects.toMatchObject({ statusCode: 400 });
    await expect(
      addDealChangeOrder(tdb, { dealId: DEAL_WON, signedDate: "2026-03-15", amount: -10, createdBy: USER }),
    ).rejects.toMatchObject({ statusCode: 400 });
  });
  it("rejects a malformed signed date", async () => {
    await expect(
      addDealChangeOrder(tdb, { dealId: DEAL_WON, signedDate: "March 5", amount: 100, createdBy: USER }),
    ).rejects.toMatchObject({ statusCode: 400 });
  });
});

describe("sumDealChangeOrders", () => {
  it("returns 0 when there are none", async () => {
    expect(Number(await sumDealChangeOrders(tdb, DEAL_WON))).toBe(0);
  });
  it("sums amounts cents-exactly", async () => {
    await addDealChangeOrder(tdb, { dealId: DEAL_WON, signedDate: "2026-03-15", amount: "100.10", createdBy: USER });
    await addDealChangeOrder(tdb, { dealId: DEAL_WON, signedDate: "2026-03-16", amount: "0.20", createdBy: USER });
    await addDealChangeOrder(tdb, { dealId: DEAL_WON, signedDate: "2026-03-17", amount: "1000000.00", createdBy: USER });
    expect(Number(await sumDealChangeOrders(tdb, DEAL_WON))).toBe(1000100.3);
  });
});

describe("listDealChangeOrders", () => {
  it("returns the deal's change orders newest signed-date first", async () => {
    await addDealChangeOrder(tdb, { dealId: DEAL_WON, signedDate: "2026-01-01", amount: 1, createdBy: USER });
    await addDealChangeOrder(tdb, { dealId: DEAL_WON, signedDate: "2026-05-01", amount: 2, createdBy: USER });
    const rows = await listDealChangeOrders(tdb, DEAL_WON);
    expect(rows.map((r: { signedDate: string }) => r.signedDate)).toEqual(["2026-05-01", "2026-01-01"]);
  });
});

describe("updateDealChangeOrder / deleteDealChangeOrder", () => {
  it("updates amount/date/description and rejects an invalid amount", async () => {
    const co = await addDealChangeOrder(tdb, { dealId: DEAL_WON, signedDate: "2026-03-15", amount: 100, createdBy: USER });
    const updated = await updateDealChangeOrder(tdb, {
      id: co.id,
      dealId: DEAL_WON,
      amount: "250",
      signedDate: "2026-06-01",
      description: "revised",
      updatedBy: USER,
    });
    expect(Number(updated.amount)).toBe(250);
    expect(updated.signedDate).toBe("2026-06-01");
    expect(updated.description).toBe("revised");
    await expect(
      updateDealChangeOrder(tdb, { id: co.id, dealId: DEAL_WON, amount: -1, updatedBy: USER }),
    ).rejects.toMatchObject({ statusCode: 400 });
  });
  it("404s updating/deleting a change order under the wrong deal", async () => {
    const co = await addDealChangeOrder(tdb, { dealId: DEAL_WON, signedDate: "2026-03-15", amount: 100, createdBy: USER });
    await expect(
      updateDealChangeOrder(tdb, { id: co.id, dealId: DEAL_BBO, amount: 5, updatedBy: USER }),
    ).rejects.toMatchObject({ statusCode: 404 });
    await expect(
      deleteDealChangeOrder(tdb, { id: co.id, dealId: DEAL_BBO }),
    ).rejects.toMatchObject({ statusCode: 404 });
  });
  it("deletes a change order and returns the removed row (for audit)", async () => {
    const co = await addDealChangeOrder(tdb, { dealId: DEAL_WON, signedDate: "2026-03-15", amount: 100, createdBy: USER });
    const removed = await deleteDealChangeOrder(tdb, { id: co.id, dealId: DEAL_WON });
    expect(removed.id).toBe(co.id);
    expect(Number(removed.amount)).toBe(100);
    expect((await listDealChangeOrders(tdb, DEAL_WON)).length).toBe(0);
  });
});

describe("getDealChangeOrderById", () => {
  it("returns the change order scoped to its deal, or null across deals", async () => {
    const co = await addDealChangeOrder(tdb, { dealId: DEAL_WON, signedDate: "2026-03-15", amount: 100, createdBy: USER });
    expect((await getDealChangeOrderById(tdb, co.id, DEAL_WON))?.id).toBe(co.id);
    expect(await getDealChangeOrderById(tdb, co.id, DEAL_BBO)).toBeNull();
  });
});

describe("disjoint-sum invariant (CO value is incremental, never baked into the base)", () => {
  async function awardedAmount(dealId: string): Promise<string | null> {
    const r = await pg.query<{ awarded_amount: string | null }>(
      `SELECT awarded_amount FROM deals WHERE id = $1`,
      [dealId],
    );
    return r.rows[0]?.awarded_amount ?? null;
  }

  it("adding / editing / deleting a change order NEVER mutates the parent deal's awarded base", async () => {
    expect(Number(await awardedAmount(DEAL_WON))).toBe(100000);

    const co = await addDealChangeOrder(tdb, { dealId: DEAL_WON, signedDate: "2026-03-15", amount: "5000", createdBy: USER });
    expect(Number(await awardedAmount(DEAL_WON))).toBe(100000); // base unchanged by add

    await updateDealChangeOrder(tdb, { id: co.id, dealId: DEAL_WON, amount: "6000", updatedBy: USER });
    expect(Number(await awardedAmount(DEAL_WON))).toBe(100000); // base unchanged by edit

    await deleteDealChangeOrder(tdb, { id: co.id, dealId: DEAL_WON });
    expect(Number(await awardedAmount(DEAL_WON))).toBe(100000); // base unchanged by delete
  });

  it("current contract value = base + SUM(change orders), counted exactly once (no double-count)", async () => {
    // CO value lives ONLY in deal_change_orders; the base (awarded_amount) excludes it. The total is
    // derived by adding the two disjoint sources — the CO amount must NOT also appear in the base.
    await addDealChangeOrder(tdb, { dealId: DEAL_WON, signedDate: "2026-03-15", amount: "5000", createdBy: USER });
    await addDealChangeOrder(tdb, { dealId: DEAL_WON, signedDate: "2026-04-15", amount: "2500", createdBy: USER });

    const base = Number(await awardedAmount(DEAL_WON)); // 100000, CO-free
    const coSum = Number(await sumDealChangeOrders(tdb, DEAL_WON)); // 7500
    expect(base).toBe(100000);
    expect(coSum).toBe(7500);
    expect(base + coSum).toBe(107500); // disjoint: each dollar counted once
  });
});
