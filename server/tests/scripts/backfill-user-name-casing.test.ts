import { describe, expect, it } from "vitest";
import { planNameCasingChanges } from "../../src/scripts/backfill-user-name-casing.js";

function row(display_name: string | null, overrides: Partial<{ id: string; email: string; role: string }> = {}) {
  return {
    id: overrides.id ?? "u1",
    email: overrides.email ?? "someone@trockgc.com",
    role: overrides.role ?? "rep",
    display_name,
  };
}

describe("planNameCasingChanges", () => {
  it("plans a change only for rows that are actually wrong", () => {
    const changes = planNameCasingChanges([
      row("nick reyes", { id: "u1" }),
      row("Adam Shaw", { id: "u2" }),
      row("Edward McCarty", { id: "u3" }),
    ]);

    expect(changes.map((c) => c.id)).toEqual(["u1"]);
    expect(changes[0]!.before).toBe("nick reyes");
    expect(changes[0]!.after).toBe("Nick Reyes");
    expect(changes[0]!.source).toBe("rule");
  });

  it("uses the curated spelling where the conservative rule cannot get there", () => {
    // The general rule yields "Corey Mcshane"; the roster says McShane. If this ever silently fell back to
    // the rule, the backfill would write a name that is still wrong — and being a one-time script, nobody
    // would look again.
    const changes = planNameCasingChanges([row("corey mcshane")]);

    expect(changes).toHaveLength(1);
    expect(changes[0]!.after).toBe("Corey McShane");
    expect(changes[0]!.source).toBe("curated");
  });

  it("matches a curated override regardless of the stored capitalisation", () => {
    expect(planNameCasingChanges([row("COREY MCSHANE")])[0]!.after).toBe("Corey McShane");
    expect(planNameCasingChanges([row("Corey Mcshane")])[0]!.after).toBe("Corey McShane");
  });

  it("plans nothing for an already-correct row, so a re-run is a no-op", () => {
    expect(planNameCasingChanges([row("Corey McShane"), row("Nick Reyes")])).toEqual([]);
  });

  it("is idempotent — applying the plan and re-planning yields nothing", () => {
    const first = planNameCasingChanges([row("nick reyes"), row("corey mcshane", { id: "u2" })]);
    const applied = first.map((c) => row(c.after, { id: c.id }));
    expect(planNameCasingChanges(applied)).toEqual([]);
  });

  it("ignores blank and null names rather than proposing an empty write", () => {
    expect(planNameCasingChanges([row(null), row(""), row("   ")])).toEqual([]);
  });

  it("carries the identifying fields through for the review output", () => {
    const changes = planNameCasingChanges([
      row("kevin posey", { id: "u9", email: "kposey@trockcontracting.com", role: "field_contractor" }),
    ]);

    expect(changes[0]).toMatchObject({
      id: "u9",
      email: "kposey@trockcontracting.com",
      role: "field_contractor",
      before: "kevin posey",
      after: "Kevin Posey",
    });
  });
});
