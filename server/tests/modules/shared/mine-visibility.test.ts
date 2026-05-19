import { describe, expect, it, vi } from "vitest";
import { buildDealMineVisibilityCondition, buildLeadMineVisibilityCondition } from "../../../src/modules/shared/mine-visibility.js";

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
});
