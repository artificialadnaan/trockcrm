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

// The module-level db is read for the stage list (getDealsForPipeline + listDealStages). Return a
// Won + Opportunity stage so getDealsForPipeline issues per-stage queries we can capture.
const stageState = vi.hoisted(() => ({
  stages: [
    { id: "00000000-0000-0000-0000-0000000057a2", slug: "opportunity", name: "Opportunity", workflowFamily: "standard_deal", displayOrder: 1, isActivePipeline: true, isTerminal: false },
    { id: "00000000-0000-0000-0000-0000000057a1", slug: "won", name: "Won", workflowFamily: "standard_deal", displayOrder: 9, isActivePipeline: true, isTerminal: true },
  ] as unknown[],
}));

/** Drizzle's own name symbol, so the check needs no import inside a hoisted mock factory. */
function isPipelineStageConfigTable(table: unknown): boolean {
  if (!table || typeof table !== "object") return false;
  return (table as Record<symbol, unknown>)[Symbol.for("drizzle:Name")] === "pipeline_stage_config";
}

// listDealStages() still reads the module-level db. getDealsForPipeline's OWN stage read moved to the
// REQUEST's tenant client (it used to take a SECOND pool slot from this global pool while the tenant
// middleware already held one for the whole request), so capturingTenantDb below answers it as well.
vi.mock("../../../src/db.js", () => {
  const chain: Record<string, unknown> = {};
  chain.select = () => chain;
  chain.from = () => chain;
  chain.where = () => chain;
  chain.orderBy = () => Promise.resolve(stageState.stages);
  (chain as { then: unknown }).then = (resolve: (v: unknown) => unknown) => resolve(stageState.stages);
  return { db: chain, pool: {} };
});

function capturingTenantDb() {
  const wheres: unknown[] = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let fromTable: unknown = null;
  const chain: any = new Proxy(function () {}, {
    apply: () => chain,
    get(_t, prop) {
      // The board's pipeline_stage_config read runs on the tenant client now; answer it with the stage
      // list so the per-stage queries this test captures are still issued.
      if (prop === "then")
        return (resolve: (rows: unknown[]) => unknown) =>
          resolve(isPipelineStageConfigTable(fromTable) ? stageState.stages : []);
      if (prop === "from") return (table: unknown) => { fromTable = table; return chain; };
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

  it("includeSubscriptionDeletedAt:false OMITS the deleted_at guard (offices whose table lacks the column)", () => {
    expect(render(buildDealWatchedCondition(USER))).toContain("deleted_at is null");
    expect(render(buildDealWatchedCondition(USER, { includeSubscriptionDeletedAt: false }))).not.toContain("deleted_at is null");
    expect(render(buildAliasedDealWatchedCondition("d", USER, { includeSubscriptionDeletedAt: false }))).not.toContain("deleted_at is null");
  });
});

describe("getDealsForPipeline (kanban) — watched arm composes correctly", () => {
  it("scope=watched → per-stage WHERE carries the subscription predicate and NO Mine clauses", async () => {
    state.features.dealSubscriptions = true;
    const { db, wheres } = capturingTenantDb();
    const { getDealsForPipeline } = await import("../../../src/modules/deals/service.js");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await getDealsForPipeline(db, "rep", USER, { scope: "watched" } as any);
    const subWheres = wheres.map(render).filter((w) => w.includes("deal_subscriptions"));
    expect(subWheres.length).toBeGreaterThan(0);
    for (const w of subWheres) expect(w).not.toContain("assigned_rep_id");
  });

  it("scope=watched + assignedRepId → ANDs the subscription predicate WITH the rep narrowing (assignedRepFilterHandled stays false)", async () => {
    state.features.dealSubscriptions = true;
    const { db, wheres } = capturingTenantDb();
    const { getDealsForPipeline } = await import("../../../src/modules/deals/service.js");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await getDealsForPipeline(db, "rep", USER, { scope: "watched", assignedRepId: USER } as any);
    const w = wheres.map(render).find((x) => x.includes("deal_subscriptions"));
    expect(w).toBeTruthy();
    expect(w).toContain("assigned_rep_id");
  });

  it("scope=watched + no deal_subscriptions table → degrades to empty (false), not Mine/All", async () => {
    state.features.dealSubscriptions = false;
    const { db, wheres } = capturingTenantDb();
    const { getDealsForPipeline } = await import("../../../src/modules/deals/service.js");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await getDealsForPipeline(db, "rep", USER, { scope: "watched" } as any);
    const rendered = wheres.map(render);
    expect(rendered.some((w) => w.includes("deal_subscriptions"))).toBe(false);
    expect(rendered.some((w) => /\bfalse\b/.test(w))).toBe(true);
    state.features.dealSubscriptions = true;
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
