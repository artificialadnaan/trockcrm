// The server-side half of the field-contractor invariant for `users.generates_sales` (migration 0219).
//
// The admin users table disables this checkbox for contractors, but the PATCH route hands `req.body`
// straight through to updateUser, so the UI is not a gate. Without this rule a hand-made request could
// enrol a field contractor in the rep cards, the funnel, the performance snapshots, the strategic alerts
// and the coaching prompts — every surface the flag drives — while `acceptFieldInvite` explicitly creates
// contractors with the flag OFF and the commission roster excludes the role outright.
import { describe, expect, it, vi } from "vitest";

vi.mock("../../../src/db.js", () => ({ db: {} }));

const { assertGeneratesSalesAllowedForRole } = await import(
  "../../../src/modules/admin/users-service.js"
);

describe("assertGeneratesSalesAllowedForRole", () => {
  it("rejects ticking the flag on for a field contractor", () => {
    expect(() => assertGeneratesSalesAllowedForRole(true, "field_contractor")).toThrow(
      /Field contractors cannot be marked as generating sales/
    );
  });

  it("allows every CRM role to be ticked on", () => {
    // Including director and admin: the whole point of the flag is that sales attribution is orthogonal
    // to access, so a director who runs deals must be tickable.
    for (const role of ["rep", "director", "admin", "construction"]) {
      expect(() => assertGeneratesSalesAllowedForRole(true, role)).not.toThrow();
    }
  });

  it("always allows turning the flag OFF, whatever the role", () => {
    // The rule guards enrolment, not removal. Blocking a contractor from being set false would make the
    // invariant unrepairable if a row ever got there another way.
    for (const role of ["field_contractor", "rep", "director", "admin", "construction"]) {
      expect(() => assertGeneratesSalesAllowedForRole(false, role)).not.toThrow();
    }
  });

  it("is evaluated against the role the request is MOVING TO", () => {
    // updateUser passes `nextRole ?? existingUser.role`. A single PATCH that demotes someone to
    // field_contractor AND ticks the flag on must be rejected — checking the OLD role would let it
    // through and leave a contractor on every roster.
    expect(() => assertGeneratesSalesAllowedForRole(true, "field_contractor")).toThrow();
    // ...and the reverse promotion is fine: contractor -> rep with the flag on.
    expect(() => assertGeneratesSalesAllowedForRole(true, "rep")).not.toThrow();
  });

  it("does not treat an unknown or missing role as a contractor", () => {
    // Fail OPEN here on purpose: this rule exists to block one specific role, and a null/unknown role is
    // not that role. Failing closed would silently block legitimate ticks whenever the shape changed.
    for (const role of [null, undefined, "", "unknown_future_role"]) {
      expect(() => assertGeneratesSalesAllowedForRole(true, role)).not.toThrow();
    }
  });
});
