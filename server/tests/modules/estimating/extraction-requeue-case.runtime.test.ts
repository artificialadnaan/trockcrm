// The requeue CASE, EXECUTED rather than described.
//
// `updateEstimateExtraction` decides an extraction's next status in SQL, under the UPDATE's own row
// lock, precisely because a JavaScript boolean computed from a stale snapshot cannot see a concurrent
// claim. The existing suite for this file asserts on mocked call arguments and never runs the CASE:
// inverting it to `… then <status> else 'pending' end` — so a `needs_quantity` row is NEVER requeued
// and a `rejected` one always is — left all 16 of those tests green.
//
// Here the service runs against a real Postgres. Every row is seeded at a known status, PATCHed
// through the shipping function, and read back: the assertion is the status the DATABASE holds.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import {
  estimateExtractionMatches,
  estimateExtractions,
  estimatePricingRecommendations,
  estimateReviewEvents,
} from "@trock-crm/shared/schema";
import { tenantSchemaSql } from "../../helpers/tenant-schema-from-drizzle.js";
import { updateEstimateExtraction } from "../../../src/modules/estimating/extraction-review-service.js";

const U = (suffix: string) => `00000000-0000-4000-8000-${suffix.padStart(12, "0")}`;
const DEAL = U("d1");
const DOCUMENT = U("f1");
const USER = U("e11");

let pg: PGlite;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let tenantDb: any;
let seedCounter = 1;

async function seedExtraction(status: string, quantity: string | null) {
  const id = U(`a${seedCounter++}`);
  await tenantDb.insert(estimateExtractions).values({
    id,
    dealId: DEAL,
    documentId: DOCUMENT,
    extractionType: "scope_line",
    rawLabel: `row-${status}`,
    normalizedLabel: `row-${status}`,
    quantity,
    status,
  });

  return id;
}

async function statusOf(id: string): Promise<string> {
  const { rows } = (await pg.query("SELECT status FROM estimate_extractions WHERE id = $1", [id])) as {
    rows: Array<{ status: string }>;
  };

  return rows[0].status;
}

async function quantityOf(id: string): Promise<string | null> {
  const { rows } = (await pg.query(
    "SELECT quantity::text AS quantity FROM estimate_extractions WHERE id = $1",
    [id]
  )) as { rows: Array<{ quantity: string | null }> };

  return rows[0].quantity;
}

beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(
    tenantSchemaSql("public", [
      estimateExtractions,
      estimateExtractionMatches,
      estimatePricingRecommendations,
      estimateReviewEvents,
    ])
  );
  tenantDb = drizzle(pg);
}, 60_000);

afterAll(async () => {
  await pg?.close();
});

beforeEach(async () => {
  seedCounter = 1;
  await pg.exec(`
    TRUNCATE estimate_review_events, estimate_pricing_recommendations,
             estimate_extraction_matches, estimate_extractions;
  `);
});

describe("supplying a usable quantity puts the row back in the queue", () => {
  // `needs_quantity` is a flag, not a trap: the generation job skips a quantity-less row and marks it,
  // and the candidate query then re-selects ordinary rows ONLY at `pending`. A row corrected here that
  // kept its flag would never be priced again — the estimator does exactly what the flag asks and the
  // row silently stays dead.
  const requeued = ["needs_quantity", "processed", "approved", "unmatched"];

  for (const status of requeued) {
    it(`moves a ${status} row to pending`, async () => {
      const id = await seedExtraction(status, null);

      const { extraction } = await updateEstimateExtraction({
        tenantDb,
        dealId: DEAL,
        extractionId: id,
        userId: USER,
        input: { quantity: "700" },
      });

      expect(await statusOf(id)).toBe("pending");
      // Read off the UPDATED row, which is what the audit event records — the CASE is resolved by the
      // database, so nothing else knows what it became.
      expect(extraction.status).toBe("pending");
      expect(Number(await quantityOf(id))).toBe(700);
    });
  }

  it("leaves a REJECTED row rejected — that decision is not this edit's to overturn", async () => {
    // A rejection says the line does not belong in the estimate at all. It is not stranded by staying
    // put, and requeuing it would push a refused row back into pricing.
    const id = await seedExtraction("rejected", null);

    await updateEstimateExtraction({
      tenantDb,
      dealId: DEAL,
      extractionId: id,
      userId: USER,
      input: { quantity: "700" },
    });

    expect(await statusOf(id)).toBe("rejected");
    // The quantity is still written — the edit is honoured, only the status is left alone.
    expect(Number(await quantityOf(id))).toBe(700);
  });

  it("does NOT requeue on an edit that never touched the quantity", async () => {
    // `nextQuantity` falls back to the existing value when the field is omitted, so on a priced row
    // "the request carries a quantity" is true for EVERY edit. Requeuing on a label change bought a
    // whole generation run for an edit that did not touch pricing.
    const id = await seedExtraction("processed", "700");

    await updateEstimateExtraction({
      tenantDb,
      dealId: DEAL,
      extractionId: id,
      userId: USER,
      input: { normalizedLabel: "Renamed" },
    });

    expect(await statusOf(id)).toBe("processed");
  });

  it("does NOT requeue when the quantity is re-sent unchanged, scale and all", async () => {
    // `numeric(14,3)` round-trips as "700.000". Comparing as strings would call every re-save an edit.
    const id = await seedExtraction("processed", "700");

    await updateEstimateExtraction({
      tenantDb,
      dealId: DEAL,
      extractionId: id,
      userId: USER,
      input: { quantity: "700.000" },
    });

    expect(await statusOf(id)).toBe("processed");
  });
});

describe("removing a usable quantity flags the row instead of stranding it", () => {
  // Restricting this to null left the worst version of the original bug in place: moving a `processed`
  // row from 700 to "0" satisfied neither branch, so the status was untouched — outside the worker's
  // `pending` filter, refused by the promote predicate, and absent from the needs-quantity bucket that
  // exists to surface exactly that.
  for (const unpriceable of [null, "0", "-5"]) {
    it(`flags a processed row whose quantity became ${unpriceable ?? "null"}`, async () => {
      const id = await seedExtraction("processed", "700");

      await updateEstimateExtraction({
        tenantDb,
        dealId: DEAL,
        extractionId: id,
        userId: USER,
        input: { quantity: unpriceable },
      });

      expect(await statusOf(id)).toBe("needs_quantity");
    });
  }

  it("leaves an APPROVED row approved when the quantity is cleared", async () => {
    // The asymmetry is deliberate and it is stated in the source: a cleared quantity leaves nothing to
    // re-price, so reopening the row buys no repair and still costs a human decision — and the promote
    // predicate already holds that row back. Supplying a usable number is the opposite case.
    const id = await seedExtraction("approved", "700");

    await updateEstimateExtraction({
      tenantDb,
      dealId: DEAL,
      extractionId: id,
      userId: USER,
      input: { quantity: null },
    });

    expect(await statusOf(id)).toBe("approved");
  });
});

describe("a quantity of zero is stored as zero, not swallowed", () => {
  it("writes a NULL-to-0 edit through and records both values in the audit trail", async () => {
    // NOT a test of the null/0 comparison fix, and it must not be mistaken for one: `quantityChanged`
    // has a single consumer that ANDs it with `suppliesQuantity`, which is false for 0, so correcting
    // the comparison changes no observable behaviour and nothing here fails on the old version. What IS
    // worth pinning is that the value reaches the row and the event, and that a `pending` row is left
    // pending — the generation job's candidate filter admits `pending`, so it will flag this row itself
    // on the next run rather than it being stranded here.
    const id = await seedExtraction("pending", null);

    const { extraction, reviewEvent } = await updateEstimateExtraction({
      tenantDb,
      dealId: DEAL,
      extractionId: id,
      userId: USER,
      input: { quantity: "0" },
    });

    expect(Number(await quantityOf(id))).toBe(0);
    expect(Number(extraction.quantity)).toBe(0);
    expect(await statusOf(id)).toBe("pending");

    const event = reviewEvent as {
      beforeJson: { quantity: string | null };
      afterJson: { quantity: string | null };
    };
    expect(event.beforeJson.quantity).toBeNull();
    expect(Number(event.afterJson.quantity)).toBe(0);
  });

  it("does NOT treat re-sending the same null as a change", async () => {
    const id = await seedExtraction("processed", null);

    await updateEstimateExtraction({
      tenantDb,
      dealId: DEAL,
      extractionId: id,
      userId: USER,
      input: { quantity: null },
    });

    // Neither branch fires: nothing became unpriceable (it never was priceable) and nothing usable was
    // supplied. The status is untouched.
    expect(await statusOf(id)).toBe("processed");
  });
});

describe("the audit trail agrees with the row", () => {
  it("records the status transition the database actually resolved", async () => {
    const id = await seedExtraction("needs_quantity", null);

    const { reviewEvent } = await updateEstimateExtraction({
      tenantDb,
      dealId: DEAL,
      extractionId: id,
      userId: USER,
      input: { quantity: "700" },
    });

    const event = reviewEvent as {
      beforeJson: { status: string; quantity: string | null };
      afterJson: { status: string; quantity: string | null };
    };
    expect(event.beforeJson.status).toBe("needs_quantity");
    expect(event.afterJson.status).toBe("pending");
    expect(await statusOf(id)).toBe(event.afterJson.status);
  });
});
