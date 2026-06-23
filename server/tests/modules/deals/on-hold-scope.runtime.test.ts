import { describe, it, expect, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import { buildDealOnHoldCondition } from "../../../src/modules/shared/mine-visibility.js";
import {
  normalizeCollaborativeScope,
  getCollaborativeReadRole,
} from "../../../src/lib/collaboration-access.js";
import { readListScope as readDealsListScope } from "../../../src/modules/deals/routes.js";
import { readListScope as readLeadsListScope } from "../../../src/modules/leads/routes.js";

/**
 * On Hold scope — the 4th deals-only filter pill (Mine / All / Watched / On Hold).
 * Acceptance: scope=on_hold emits ONLY the shared effective-on-hold predicate (stored on_hold OR a close
 * target more than 90 CT-days out — the SAME rule value-zeroing/reports reuse), distinct from Mine (ownership) and
 * Watched (deal_subscriptions). Unlike Watched there is NO capability gate (base columns, always present),
 * it is an office-wide overview (elevates a rep like All, NOT self-scoped), and it is contained to deals
 * (on_hold → mine on leads).
 */

const dialect = new PgDialect();
const render = (v: unknown) => dialect.sqlToQuery(v as never).sql.toLowerCase();

// The module-level db is read for the stage list (getDealsForPipeline + listDealStages). Return a
// Won + Opportunity stage so getDealsForPipeline issues per-stage queries we can capture.
vi.mock("../../../src/db.js", () => {
  const stages = [
    { id: "00000000-0000-0000-0000-0000000057a2", slug: "opportunity", name: "Opportunity", workflowFamily: "standard_deal", displayOrder: 1, isActivePipeline: true, isTerminal: false },
    { id: "00000000-0000-0000-0000-0000000057a1", slug: "won", name: "Won", workflowFamily: "standard_deal", displayOrder: 9, isActivePipeline: true, isTerminal: true },
  ];
  const chain: Record<string, unknown> = {};
  chain.select = () => chain;
  chain.from = () => chain;
  chain.where = () => chain;
  chain.orderBy = () => Promise.resolve(stages);
  (chain as { then: unknown }).then = (resolve: (v: unknown) => unknown) => resolve(stages);
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

describe("buildDealOnHoldCondition — effective-on-hold predicate in isolation", () => {
  it("emits stored on_hold OR a close target past the 90-day horizon, qualified to the deals relation", () => {
    const text = render(buildDealOnHoldCondition("deals"));
    expect(text).toContain("coalesce(deals.on_hold, false) = true");
    expect(text).toContain("deals.expected_close_date is not null");
    expect(text).toContain("interval '90 days'");
    // SAME America/Chicago day boundary the forecast SQL + at-risk rule use, so the pill agrees to the day.
    expect(text).toContain("(now() at time zone 'america/chicago')::date");
    // It is NOT the Watched (subscription) or Mine (ownership) predicate.
    expect(text).not.toContain("deal_subscriptions");
    expect(text).not.toContain("assigned_rep_id");
  });

  it("aliased form qualifies the columns to the query's alias", () => {
    const text = render(buildDealOnHoldCondition("d"));
    expect(text).toContain("coalesce(d.on_hold, false) = true");
    expect(text).toContain("d.expected_close_date is not null");
    expect(text).toContain("interval '90 days'");
  });
});

describe("getDeals — on_hold is DISTINCT from Mine / All / Watched", () => {
  it("scope=on_hold → visibility WHERE is the effective-on-hold predicate ONLY (no ownership, no subscription)", async () => {
    const { db, wheres } = capturingTenantDb();
    const { getDeals } = await import("../../../src/modules/deals/service.js");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await getDeals(db, { scope: "on_hold" } as any, "rep", USER);
    const visibility = wheres.map(render).find((w) => w.includes("expected_close_date"));
    expect(visibility).toBeTruthy();
    expect(visibility).toContain("on_hold");
    expect(visibility).toContain("interval '90 days'");
    const all = wheres.map(render).join(" || ");
    expect(all).not.toContain("deal_subscriptions");
  });

  it("scope=on_hold needs NO capability gate → never degrades to a bare false()", async () => {
    const { db, wheres } = capturingTenantDb();
    const { getDeals } = await import("../../../src/modules/deals/service.js");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await getDeals(db, { scope: "on_hold" } as any, "rep", USER);
    const visibility = wheres.map(render).find((w) => w.includes("expected_close_date"));
    expect(visibility).toBeTruthy();
    // the on_hold visibility arm is the predicate, not a standalone "false"
    expect(/^\s*false\s*$/.test(visibility ?? "x")).toBe(false);
  });
});

describe("getDealsForPipeline (kanban) — on_hold arm composes correctly", () => {
  it("scope=on_hold → per-stage WHERE carries the effective-on-hold predicate", async () => {
    const { db, wheres } = capturingTenantDb();
    const { getDealsForPipeline } = await import("../../../src/modules/deals/service.js");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await getDealsForPipeline(db, "rep", USER, { scope: "on_hold" } as any);
    const holdWheres = wheres.map(render).filter((w) => w.includes("expected_close_date"));
    expect(holdWheres.length).toBeGreaterThan(0);
    for (const w of holdWheres) expect(w).toContain("on_hold");
  });

  it("scope=on_hold + assignedRepId → ANDs the predicate WITH the rep narrowing (assignedRepFilterHandled stays false)", async () => {
    const { db, wheres } = capturingTenantDb();
    const { getDealsForPipeline } = await import("../../../src/modules/deals/service.js");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await getDealsForPipeline(db, "rep", USER, { scope: "on_hold", assignedRepId: USER } as any);
    const w = wheres.map(render).find((x) => x.includes("expected_close_date"));
    expect(w).toBeTruthy();
    expect(w).toContain("assigned_rep_id");
  });
});

describe("server scope gates — on_hold survives for deals, contained for leads, elevates like All", () => {
  it("deals readListScope passes 'on_hold' through (not coerced to mine)", () => {
    expect(readDealsListScope("on_hold", "rep")).toBe("on_hold");
    expect(readDealsListScope("nonsense", "rep")).toBe("mine");
  });

  it("normalizeCollaborativeScope passes 'on_hold' through", () => {
    expect(normalizeCollaborativeScope("rep", "on_hold")).toBe("on_hold");
  });

  it("getCollaborativeReadRole elevates a rep on 'on_hold' like 'all' (it is an office-wide overview, not self-scoped)", () => {
    expect(getCollaborativeReadRole("rep", "on_hold")).toBe("director");
    expect(getCollaborativeReadRole("rep", "all")).toBe("director");
    // watched stays self-scoped (the subscription IS the ownership), so it must NOT elevate
    expect(getCollaborativeReadRole("rep", "watched")).toBe("rep");
  });

  it("leads readListScope CONTAINS 'on_hold' → mine (no leads leak)", () => {
    expect(readLeadsListScope("on_hold")).toBe("mine");
  });
});
