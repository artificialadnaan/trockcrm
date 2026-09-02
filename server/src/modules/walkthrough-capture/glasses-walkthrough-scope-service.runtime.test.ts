// REAL-SQL (PGlite) proof for `loadDealGlassesWalkthroughRows` — the database half of the deal page's
// AI-walk panel. The network half is a pure unit suite (glasses-walkthrough-scope-service.test.ts); this
// one exists because the two properties that matter here are properties of a QUERY, not of TypeScript: that
// it returns this deal's walks and nobody else's, and that its order is total.
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { glassesWalkthroughs } from "@trock-crm/shared/schema";
import type { GlassesWalkCaptureCensus } from "@trock-crm/shared/types";
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
  // `users` IS stood up, unlike `deals`, because the read now LEFT JOINs it for the capturer's display
  // name — without it every case here fails on a missing relation rather than on its own subject. Only the
  // two columns the join touches, so this stays a stand-in for the real table rather than a copy of it that
  // would need its role enum and its offices FK; the shipped DDL is exercised in the migration suite.
  await pg.exec(`CREATE TABLE users (id uuid PRIMARY KEY, display_name varchar(255) NOT NULL);`);
  tenantDb = drizzle(pg);
});

afterAll(async () => {
  await pg.close();
});

beforeEach(async () => {
  await pg.exec("DELETE FROM glasses_walkthroughs");
  await pg.exec("DELETE FROM users");
  await pg.query(`INSERT INTO users (id, display_name) VALUES ($1, $2)`, [USER, "Dana Reyes"]);
});

async function seed(args: {
  dealId: string;
  walkId: string;
  capturedAt: string;
  scopeWalkthroughId?: string | null;
  capturedByUserId?: string | null;
  captureCensus?: GlassesWalkCaptureCensus | null;
}) {
  const [inserted] = await tenantDb
    .insert(glassesWalkthroughs)
    .values({
      dealId: args.dealId,
      walkId: args.walkId,
      capturedAt: new Date(args.capturedAt),
      scopeWalkthroughId: args.scopeWalkthroughId ?? null,
      capturedByUserId: args.capturedByUserId === undefined ? USER : args.capturedByUserId,
      captureCensus: args.captureCensus ?? null,
    })
    .returning({ id: glassesWalkthroughs.id });
  return inserted.id as string;
}

/** The census of a walk that went badly, as the ingest stores it. */
function census(): GlassesWalkCaptureCensus {
  return {
    walkMs: 1_800_000,
    video: { framesReceived: 54_000, framesAppended: 1_800, framesDropped: 52_200, secondsSinceLastFrameArrived: 1_740.5 },
    audio: {
      buffersReceived: 90_000,
      buffersAppended: 78_600,
      buffersDropped: 11_400,
      longestDropRun: 11_400,
      secondsAppended: 1_572,
      engineRestarts: 2,
      standaloneSecondsRecorded: 1_500,
      events: [{ atMs: 60_000, kind: "video-stalled" }],
    },
  };
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
      capturedByName: "Dana Reyes",
      captureCensus: null,
    });
  });

  it("carries the stored capture census through the read, and null for a walk filed without one", async () => {
    // The whole document, not a summary: the reader is diagnosing a bad walk and the counters ARE the
    // diagnosis. jsonb round-trips the object; only the key order is Postgres's, which toEqual ignores.
    await seed({ dealId: DEAL, walkId: "walk-counted", capturedAt: "2026-09-02T14:00:00.000Z", captureCensus: census() });
    await seed({ dealId: DEAL, walkId: "walk-uncounted", capturedAt: "2026-09-02T13:00:00.000Z" });

    const rows = await loadDealGlassesWalkthroughRows(tenantDb, DEAL);
    expect(rows.map((row) => [row.walkId, row.captureCensus])).toEqual([
      ["walk-counted", census()],
      ["walk-uncounted", null],
    ]);
  });

  it("RESOLVES the capturer's display name, which is what the panel heading shows", async () => {
    // The id alone cannot be rendered. On a deal carrying several walks the capturer is how an estimator
    // tells them apart, so this join is the difference between a list of timestamps and a list of walks.
    await seed({ dealId: DEAL, walkId: "walk-named", capturedAt: "2026-08-02T12:00:00.000Z" });

    const [row] = await loadDealGlassesWalkthroughRows(tenantDb, DEAL);
    expect(row!.capturedByName).toBe("Dana Reyes");
  });

  it("still returns the WALK when its capturer's user row is gone — a LEFT join, not an inner one", async () => {
    // The regression this guards is losing the walk itself in order to hide a name. `capturedByUserId`
    // survives here on purpose: the row points at a user id that no longer resolves, which is exactly the
    // state a hard-deleted user leaves behind in an install where the FK was not the one enforcing it.
    await seed({
      dealId: DEAL,
      walkId: "walk-ghost",
      capturedAt: "2026-08-02T12:00:00.000Z",
      capturedByUserId: U("99999"),
    });

    const rows = await loadDealGlassesWalkthroughRows(tenantDb, DEAL);
    expect(rows.map((row) => row.walkId)).toEqual(["walk-ghost"]);
    expect(rows[0]!.capturedByName).toBeNull();
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
    expect(row!.capturedByName).toBeNull();
  });

  it("returns an empty list for a deal with no walks, rather than failing", async () => {
    expect(await loadDealGlassesWalkthroughRows(tenantDb, DEAL)).toEqual([]);
  });
});
