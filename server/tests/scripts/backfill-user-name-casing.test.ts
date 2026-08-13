import { describe, expect, it } from "vitest";
import { planNameCasingChanges } from "../../src/scripts/backfill-user-name-casing.js";

function row(
  display_name: string | null,
  overrides: Partial<{ id: string; email: string; role: string; first_name: string | null; last_name: string | null }> = {}
) {
  const parts = (display_name ?? "").split(" ");
  return {
    id: overrides.id ?? "u1",
    email: overrides.email ?? "someone@trockgc.com",
    role: overrides.role ?? "rep",
    display_name,
    // Default to the halves of the display name, mirroring what the field-invite path writes.
    first_name: overrides.first_name !== undefined ? overrides.first_name : parts[0] ?? null,
    last_name: overrides.last_name !== undefined ? overrides.last_name : parts.slice(1).join(" ") || null,
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

  it("corrects first_name and last_name, not only display_name (Codex P2)", () => {
    // Admin → Field Users renders `{firstName} {lastName}` directly, so fixing only display_name would
    // leave exactly these users still lowercased on the screen the cleanup is meant to fix.
    const changes = planNameCasingChanges([row("nick reyes")]);

    expect(changes[0]!.fields).toEqual({
      displayName: { before: "nick reyes", after: "Nick Reyes" },
      firstName: { before: "nick", after: "Nick" },
      lastName: { before: "reyes", after: "Reyes" },
    });
  });

  it("plans the parts even when display_name is already correct", () => {
    const changes = planNameCasingChanges([
      row("Nick Reyes", { first_name: "nick", last_name: "reyes" }),
    ]);

    expect(changes).toHaveLength(1);
    expect(changes[0]!.fields.displayName).toBeUndefined();
    expect(changes[0]!.fields.firstName).toEqual({ before: "nick", after: "Nick" });
    expect(changes[0]!.fields.lastName).toEqual({ before: "reyes", after: "Reyes" });
    // The headline must still identify the row rather than printing an empty before → after.
    expect(changes[0]!.before).toBe("Nick Reyes");
  });

  it("omits a null first/last name rather than planning a write that blanks it", () => {
    const changes = planNameCasingChanges([
      row("nick reyes", { first_name: null, last_name: null }),
    ]);

    expect(changes[0]!.fields.firstName).toBeUndefined();
    expect(changes[0]!.fields.lastName).toBeUndefined();
    expect(changes[0]!.fields.displayName).toEqual({ before: "nick reyes", after: "Nick Reyes" });
  });

  it("applies a curated override to the surname column too", () => {
    const changes = planNameCasingChanges([
      row("corey mcshane", { first_name: "corey", last_name: "mcshane" }),
    ]);

    expect(changes[0]!.fields.displayName!.after).toBe("Corey McShane");
    // "mcshane" alone is a curated key in its own right, so the column agrees with the display name
    // instead of drifting to the rule's "Mcshane".
    expect(changes[0]!.fields.lastName!.after).toBe("McShane");
  });
});
