import { describe, it, expect, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import {
  buildDealWatchedCondition,
  buildAliasedDealWatchedCondition,
} from "../../../src/modules/shared/mine-visibility.js";
import {
  normalizeCollaborativeScope,
  getCollaborativeReadRole,
} from "../../../src/lib/collaboration-access.js";
import { readListScope as readDealsListScope } from "../../../src/modules/deals/routes.js";
import { readListScope as readLeadsListScope } from "../../../src/modules/leads/routes.js";

/**
 * Watched scope — the server-side half of the silent-coercion guard.
 * Load-bearing acceptance: scope=watched emits ONLY the deal_subscriptions predicate, producing a
 * WHERE distinct from BOTH Mine (assigned/created/activity + subscription) AND All (no ownership
 * filter). Plus: capability-degrade (no table → empty), self-scoped (no rep→director elevation),
 * and leads containment (watched → mine).
 */

const dialect = new PgDialect();
const render = (v: unknown) => dialect.sqlToQuery(v as never).sql.toLowerCase();

// Mutable feature flags for the capability gate (resolveMineVisibilityFeatures is mocked below).
const state = vi.hoisted(() => ({
  features: {
    dealSubscriptions: true,
    leadSubscriptions: false,
    dealSubscriptionsDeletedAt: true,
    leadSubscriptionsDeletedAt: false,
    dealsCreatedByUserId: true,
    leadsCreatedByUserId: false,
  },
}));

// Keep the real builders; only stub the capability probe so we control dealSubscriptions on/off.
vi.mock("../../../src/modules/shared/mine-visibility.js", async (importActual) => {
  const actual = await importActual<typeof import("../../../src/modules/shared/mine-visibility.js")>();
  return { ...actual, resolveMineVisibilityFeatures: async () => state.features };
});

// listDealStages reads the module-level db; stub so getDeals can resolve if it ever reaches that path.
vi.mock("../../../src/db.js", () => {
  const chain: Record<string, unknown> = {};
  chain.select = () => chain;
  chain.from = () => chain;
  chain.where = () => chain;
  chain.orderBy = () => Promise.resolve([]);
  (chain as { then: unknown }).then = (resolve: (v: unknown) => unknown) => resolve([]);
  return { db: chain, pool: {} };
});

function capturingTenantDb() {
  const wheres: unknown[] = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const chain: any = new Proxy(function () {}, {
    apply: () => chain,
    get(_t, prop) {
      if (prop === "then") return (resolve: (rows: unknown[]) => unknown) => resolve([]);
      if (prop === "where") return (arg: unknown) => { wheres.push(arg); return chain; };
      if (prop === "offset") return () => Promise.resolve([]);
      return () => chain;
    },
  });
  return { db: chain as never, wheres };
}

const USER = "00000000-0000-0000-0000-0000000000a1";

describe("buildDealWatchedCondition — subscription predicate in isolation", () => {
  it("emits the deal_subscriptions EXISTS (deleted_at is null) and NOT the Mine clauses", () => {
    const text = render(buildDealWatchedCondition(USER));
    expect(text).toContain("deal_subscriptions");
    expect(text).toContain("ds.user_id");
    expect(text).toContain("deleted_at is null");
    expect(text).not.toContain("assigned_rep_id");
    expect(text).not.toContain("created_by_user_id");
    expect(text).not.toContain("activities");
  });

  it("aliased form joins on the alias's id", () => {
    const text = render(buildAliasedDealWatchedCondition("d", USER));
    expect(text).toContain("ds.deal_id = \"d\".id");
    expect(text).toContain("deal_subscriptions");
    expect(text).not.toContain("assigned_rep_id");
  });
});

describe("getDeals — watched is DISTINCT from both Mine and All", () => {
  it("scope=watched → visibility WHERE is the subscription predicate ONLY", async () => {
    state.features.dealSubscriptions = true;
    const { db, wheres } = capturingTenantDb();
    const { getDeals } = await import("../../../src/modules/deals/service.js");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await getDeals(db, { scope: "watched" } as any, "rep", USER);
    const visibility = wheres.map(render).find((w) => w.includes("deal_subscriptions"));
    expect(visibility).toBeTruthy();
    expect(visibility).not.toContain("assigned_rep_id");
    expect(visibility).not.toContain("created_by_user_id");
  });

  it("scope=mine → WHERE has assigned_rep_id AND the subscription (the full Mine OR)", async () => {
    const { db, wheres } = capturingTenantDb();
    const { getDeals } = await import("../../../src/modules/deals/service.js");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await getDeals(db, { scope: "mine" } as any, "rep", USER);
    const visibility = wheres.map(render).find((w) => w.includes("assigned_rep_id"));
    expect(visibility).toBeTruthy();
    expect(visibility).toContain("deal_subscriptions");
  });

  it("scope=all → WHERE has NEITHER the subscription NOR an assigned_rep Mine block", async () => {
    const { db, wheres } = capturingTenantDb();
    const { getDeals } = await import("../../../src/modules/deals/service.js");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await getDeals(db, { scope: "all" } as any, "rep", USER);
    const all = wheres.map(render).join(" || ");
    expect(all).not.toContain("deal_subscriptions");
    expect(all).not.toContain("assigned_rep_id =");
  });

  it("scope=watched + no deal_subscriptions table → degrades to empty (false), not Mine/All", async () => {
    state.features.dealSubscriptions = false;
    const { db, wheres } = capturingTenantDb();
    const { getDeals } = await import("../../../src/modules/deals/service.js");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await getDeals(db, { scope: "watched" } as any, "rep", USER);
    const all = wheres.map(render);
    expect(all.some((w) => w.includes("deal_subscriptions"))).toBe(false);
    expect(all.some((w) => /\bfalse\b/.test(w))).toBe(true);
    state.features.dealSubscriptions = true; // restore
  });
});

describe("server scope gates — watched survives for deals, contained for leads, no elevation", () => {
  it("deals readListScope passes 'watched' through (not coerced to mine)", () => {
    expect(readDealsListScope("watched", "rep")).toBe("watched");
    expect(readDealsListScope("nonsense", "rep")).toBe("mine");
  });

  it("normalizeCollaborativeScope passes 'watched' through", () => {
    expect(normalizeCollaborativeScope("rep", "watched")).toBe("watched");
  });

  it("getCollaborativeReadRole does NOT elevate a rep on 'watched' (only 'all' elevates)", () => {
    expect(getCollaborativeReadRole("rep", "watched")).toBe("rep");
    expect(getCollaborativeReadRole("rep", "all")).toBe("director");
  });

  it("leads readListScope CONTAINS 'watched' → mine (no leads leak)", () => {
    expect(readLeadsListScope("watched")).toBe("mine");
  });
});
