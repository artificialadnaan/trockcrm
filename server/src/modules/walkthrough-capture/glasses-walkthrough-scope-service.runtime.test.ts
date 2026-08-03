// REAL-SQL (PGlite) proof for `loadDealGlassesWalkthroughRows` — the database half of the deal page's
// AI-walk panel. The network half is a pure unit suite (glasses-walkthrough-scope-service.test.ts); this
// one exists because the two properties that matter here are properties of a QUERY, not of TypeScript: that
// it returns this deal's walks and nobody else's, and that its order is total.
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { glassesWalkthroughs } from "@trock-crm/shared/schema";
import { tenantSchemaSql } from "../../../tests/helpers/tenant-schema-from-drizzle.js";
import { loadDealGlassesWalkthroughRows } from "./glasses-walkthrough-scope-service.js";

const U = (s: string) => `00000000-0000-4000-8000-${s.padStart(12, "0")}`;
const DEAL = U("11111");
const OTHER_DEAL = U("11112");
const USER = U("22222");

let pg: PGlite;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let tenantDb: any;

beforeAll(async () => {
  pg = new PGlite();
  // An island table — `tenantSchemaSql` omits foreign keys deliberately, so `deals` and `public.users` are
  // not stood up here. The FKs themselves are exercised against the shipped DDL in
  // server/tests/migrations/0214-glasses-walkthroughs.runtime.test.ts.
  await pg.exec(tenantSchemaSql("public", [glassesWalkthroughs]));
  tenantDb = drizzle(pg);
});

afterAll(async () => {
  await pg.close();
});

beforeEach(async () => {
  await pg.exec("DELETE FROM glasses_walkthroughs");
});

async function seed(args: {
  dealId: string;
  walkId: string;
  capturedAt: string;
  scopeWalkthroughId?: string | null;
  capturedByUserId?: string | null;
}) {
  const [inserted] = await tenantDb
    .insert(glassesWalkthroughs)
    .values({
      dealId: args.dealId,
      walkId: args.walkId,
      capturedAt: new Date(args.capturedAt),
      scopeWalkthroughId: args.scopeWalkthroughId ?? null,
      capturedByUserId: args.capturedByUserId === undefined ? USER : args.capturedByUserId,
    })
    .returning({ id: glassesWalkthroughs.id });
  return inserted.id as string;
}

describe("loadDealGlassesWalkthroughRows", () => {
  it("returns only THIS deal's walks", async () => {
    await seed({ dealId: DEAL, walkId: "walk-mine", capturedAt: "2026-08-02T10:00:00.000Z" });
    await seed({ dealId: OTHER_DEAL, walkId: "walk-theirs", capturedAt: "2026-08-02T11:00:00.000Z" });

    const rows = await loadDealGlassesWalkthroughRows(tenantDb, DEAL);
    expect(rows.map((row) => row.walkId)).toEqual(["walk-mine"]);
  });

  it("orders by the WALK's capture time, newest first — not by when the upload landed", async () => {
    // A walk recorded in the morning over a dead cellular connection uploads after one recorded at 4pm.
    // Ordered by created_at (which is insertion order here) the panel would show the afternoon walk first
    // purely because the signal came back sooner, which is not a fact about the site visit.
    await seed({ dealId: DEAL, walkId: "walk-morning", capturedAt: "2026-08-02T08:00:00.000Z" });
    await seed({ dealId: DEAL, walkId: "walk-afternoon", capturedAt: "2026-08-02T16:00:00.000Z" });
    await seed({ dealId: DEAL, walkId: "walk-noon", capturedAt: "2026-08-02T12:00:00.000Z" });

    const rows = await loadDealGlassesWalkthroughRows(tenantDb, DEAL);
    expect(rows.map((row) => row.walkId)).toEqual(["walk-afternoon", "walk-noon", "walk-morning"]);
  });

  it("GUARD: two walks captured at the same instant come back in a STABLE order", async () => {
    // Without the id tiebreak the order is whatever the scan returned, and the panel reshuffles between
    // polls — which reads as data changing rather than as an unstable sort.
    await seed({ dealId: DEAL, walkId: "walk-a", capturedAt: "2026-08-02T12:00:00.000Z" });
    await seed({ dealId: DEAL, walkId: "walk-b", capturedAt: "2026-08-02T12:00:00.000Z" });

    const first = await loadDealGlassesWalkthroughRows(tenantDb, DEAL);
    const second = await loadDealGlassesWalkthroughRows(tenantDb, DEAL);
    const third = await loadDealGlassesWalkthroughRows(tenantDb, DEAL);
    expect(second.map((row) => row.id)).toEqual(first.map((row) => row.id));
    expect(third.map((row) => row.id)).toEqual(first.map((row) => row.id));
  });

  it("carries the scope id, the capture time and the capturing user through verbatim", async () => {
    const id = await seed({
      dealId: DEAL,
      walkId: "walk-msc4vvy4-m7r30urh",
      capturedAt: "2026-08-02T22:21:47.702Z",
      scopeWalkthroughId: "b91a5bfd-1111-4222-8333-444455556666",
    });

    const [row] = await loadDealGlassesWalkthroughRows(tenantDb, DEAL);
    expect(row).toEqual({
      id,
      walkId: "walk-msc4vvy4-m7r30urh",
      scopeWalkthroughId: "b91a5bfd-1111-4222-8333-444455556666",
      capturedAt: new Date("2026-08-02T22:21:47.702Z"),
      capturedByUserId: USER,
    });
  });

  it("reports an unstamped walk's scope id as null, which is the panel's `processing` state", async () => {
    await seed({ dealId: DEAL, walkId: "walk-fresh", capturedAt: "2026-08-02T12:00:00.000Z" });

    const [row] = await loadDealGlassesWalkthroughRows(tenantDb, DEAL);
    expect(row!.scopeWalkthroughId).toBeNull();
  });

  it("survives a walk whose capturing user has since been removed", async () => {
    // The FK is ON DELETE SET NULL precisely so this row outlives the user, so the read must not assume a
    // non-null actor.
    await seed({
      dealId: DEAL,
      walkId: "walk-orphaned",
      capturedAt: "2026-08-02T12:00:00.000Z",
      capturedByUserId: null,
    });

    const [row] = await loadDealGlassesWalkthroughRows(tenantDb, DEAL);
    expect(row!.capturedByUserId).toBeNull();
  });

  it("returns an empty list for a deal with no walks, rather than failing", async () => {
    expect(await loadDealGlassesWalkthroughRows(tenantDb, DEAL)).toEqual([]);
  });
});
