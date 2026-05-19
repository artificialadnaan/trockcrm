import { describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import {
  buildAliasedDealMineVisibilityCondition,
  buildAliasedLeadMineVisibilityCondition,
  buildDealMineVisibilityCondition,
  buildLeadMineVisibilityCondition,
  resolveMineVisibilityFeatures,
} from "../../../src/modules/shared/mine-visibility.js";

vi.mock("@trock-crm/shared/schema", async () => import("../../../../shared/src/schema/index.js"));
vi.mock("@trock-crm/shared/types", async () => import("../../../../shared/src/types/index.js"));

function flatten(value: unknown): string {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object") return "";
  if (Array.isArray((value as { queryChunks?: unknown[] }).queryChunks)) {
    return (value as { queryChunks: unknown[] }).queryChunks.map(flatten).join("");
  }
  if ("name" in (value as Record<string, unknown>) && typeof (value as { name?: unknown }).name === "string") {
    return String((value as { name: string }).name);
  }
  if ("value" in (value as Record<string, unknown>)) {
    const next = (value as { value: unknown }).value;
    if (Array.isArray(next)) return next.map(flatten).join("");
    return flatten(next);
  }
  return Object.values(value as Record<string, unknown>).map(flatten).join("");
}

describe("mine visibility predicates", () => {
  const dialect = new PgDialect();

  it("includes assigned rep, creator, activity, and subscription for deals", () => {
    const text = flatten(buildDealMineVisibilityCondition("user-1")).toLowerCase();
    expect(text).toContain("assigned_rep_id");
    expect(text).toContain("created_by_user_id");
    expect(text).toContain("performed_by_user_id");
    expect(text).toContain("ds.user_id");
    expect(text).toContain("ds.deleted_at is null");
  });

  it("includes assigned rep, creator, activity, and subscription for leads", () => {
    const text = flatten(buildLeadMineVisibilityCondition("user-1")).toLowerCase();
    expect(text).toContain("assigned_rep_id");
    expect(text).toContain("created_by_user_id");
    expect(text).toContain("performed_by_user_id");
    expect(text).toContain("ls.user_id");
    expect(text).toContain("ls.deleted_at is null");
  });

  it("renders valid aliased SQL for deals", () => {
    const query = dialect.sqlToQuery(buildAliasedDealMineVisibilityCondition("d", "user-1"));

    expect(query.sql).toContain('"d".assigned_rep_id');
    expect(query.sql).toContain('"d".created_by_user_id');
    expect(query.sql).toContain('a.deal_id = "d".id');
    expect(query.sql).toContain('ds.deal_id = "d".id');
    expect(query.sql).not.toContain('[object Object]');
  });

  it("renders valid aliased SQL for leads", () => {
    const query = dialect.sqlToQuery(buildAliasedLeadMineVisibilityCondition("l", "user-1"));

    expect(query.sql).toContain('"l".assigned_rep_id');
    expect(query.sql).toContain('"l".created_by_user_id');
    expect(query.sql).toContain('a.lead_id = "l".id');
    expect(query.sql).toContain('ls.lead_id = "l".id');
    expect(query.sql).not.toContain('[object Object]');
  });

  it("can exclude subscription clauses when tenant subscription tables are unavailable", () => {
    const dealQuery = dialect.sqlToQuery(
      buildDealMineVisibilityCondition("user-1", { includeSubscriptions: false })
    );
    const leadQuery = dialect.sqlToQuery(
      buildLeadMineVisibilityCondition("user-1", { includeSubscriptions: false })
    );

    expect(dealQuery.sql).not.toContain("deal_subscriptions");
    expect(leadQuery.sql).not.toContain("lead_subscriptions");
    expect(dealQuery.sql).toContain("created_by_user_id");
    expect(leadQuery.sql).toContain("performed_by_user_id");
  });

  it("preserves subscription semantics when tenant table introspection fails unexpectedly", async () => {
    const features = await resolveMineVisibilityFeatures({
      execute: vi.fn(async () => {
        throw new Error("relation check failed");
      }),
    });

    expect(features).toEqual({
      dealSubscriptions: true,
      leadSubscriptions: true,
    });
  });
});
