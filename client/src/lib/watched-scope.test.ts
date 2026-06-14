import { describe, it, expect } from "vitest";
import { coerceScope, normalizePipelineScope, containNonDealsScope } from "@/lib/pipeline-scope";
import { resolvePreferredScope } from "@/lib/scope-preferences";

/**
 * Watched scope — the client-side half of the silent-coercion guard.
 * Deals must PRESERVE "watched" through every shared coercer; leads must CONTAIN it (→ "mine"),
 * because the scope-preference localStorage key is shared per-user across deals + leads.
 */
describe("watched scope — shared client coercers", () => {
  it("coerceScope accepts 'watched' (not null)", () => {
    expect(coerceScope("watched")).toBe("watched");
    expect(coerceScope("mine")).toBe("mine");
    expect(coerceScope("nonsense")).toBeNull();
  });

  it("resolvePreferredScope (isScope round-trip) preserves a 'watched' request", () => {
    expect(resolvePreferredScope({ requestedScope: "watched", userId: null })).toBe("watched");
  });

  it("normalizePipelineScope ALLOWS watched on deals (drill-down keeps the scope)", () => {
    expect(
      normalizePipelineScope({ role: "rep", requestedScope: "watched", entity: "deals" }).allowedScope
    ).toBe("watched");
  });

  it("normalizePipelineScope CONTAINS watched on leads → mine (no leads leak)", () => {
    expect(
      normalizePipelineScope({ role: "rep", requestedScope: "watched", entity: "leads" }).allowedScope
    ).toBe("mine");
  });

  it("containNonDealsScope coerces watched (+ parked team) → mine for every non-deals surface", () => {
    // single source of truth for leads/director/pipeline containment — guards the Round-1 /pipeline miss
    expect(containNonDealsScope("watched")).toBe("mine");
    expect(containNonDealsScope("team")).toBe("mine");
    expect(containNonDealsScope("mine")).toBe("mine");
    expect(containNonDealsScope("all")).toBe("all");
  });
});
