import { describe, it, expect } from "vitest";
import { coerceScope, normalizePipelineScope, containNonDealsScope } from "@/lib/pipeline-scope";
import { resolvePreferredScope } from "@/lib/scope-preferences";

/**
 * On Hold scope — the client-side half of the silent-coercion guard for the 4th deals pill.
 * Deals must PRESERVE "on_hold" through every shared coercer; leads/director/pipeline must CONTAIN it
 * (→ "mine"), because the scope-preference localStorage key is shared per-user across deals + leads.
 */
describe("on_hold scope — shared client coercers", () => {
  it("coerceScope accepts 'on_hold' (not null)", () => {
    expect(coerceScope("on_hold")).toBe("on_hold");
    expect(coerceScope("watched")).toBe("watched");
    expect(coerceScope("nonsense")).toBeNull();
  });

  it("resolvePreferredScope (isScope round-trip) preserves an 'on_hold' request", () => {
    expect(resolvePreferredScope({ requestedScope: "on_hold", userId: null })).toBe("on_hold");
  });

  it("normalizePipelineScope ALLOWS on_hold on deals (drill-down keeps the scope)", () => {
    expect(
      normalizePipelineScope({ role: "rep", requestedScope: "on_hold", entity: "deals" }).allowedScope
    ).toBe("on_hold");
  });

  it("normalizePipelineScope CONTAINS on_hold on leads → mine (no leads leak)", () => {
    expect(
      normalizePipelineScope({ role: "rep", requestedScope: "on_hold", entity: "leads" }).allowedScope
    ).toBe("mine");
  });

  it("containNonDealsScope coerces on_hold (+ watched + parked team) → mine for every non-deals surface", () => {
    // single source of truth for leads/director/pipeline containment — guards a deals-only-scope re-leak
    expect(containNonDealsScope("on_hold")).toBe("mine");
    expect(containNonDealsScope("watched")).toBe("mine");
    expect(containNonDealsScope("team")).toBe("mine");
    expect(containNonDealsScope("all")).toBe("all");
  });
});
