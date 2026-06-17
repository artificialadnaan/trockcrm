import { describe, expect, it } from "vitest";
import { isAssignableCrmRole } from "@trock-crm/shared/types";
import {
  isTokenVersionStale,
  isProhibitedSelfChange,
  isFieldContractorTransition,
  wouldRemoveLastActiveAdmin,
  stripsAdminPrivilege,
  evaluateUpdateUserGuards,
  planSessionInvalidation,
} from "@trock-crm/shared/lib/userProvisioningGuards";

describe("isTokenVersionStale", () => {
  it("a token whose version is BEHIND the user's is stale", () => {
    expect(isTokenVersionStale(0, 1)).toBe(true);
    expect(isTokenVersionStale(2, 5)).toBe(true);
  });
  it("a token at the current version is NOT stale (fresh post-invalidation login passes)", () => {
    expect(isTokenVersionStale(1, 1)).toBe(false);
    expect(isTokenVersionStale(7, 7)).toBe(false);
  });
  it("a missing claim version is treated as 0 — survives deploy until the user is invalidated", () => {
    expect(isTokenVersionStale(undefined, 0)).toBe(false); // never-invalidated user: pre-feature token stays valid
    expect(isTokenVersionStale(undefined, 1)).toBe(true); // once invalidated: pre-feature token is killed
  });
  it("resolves the same-instant edge a time-epoch could not", () => {
    // deactivate(v0->1) then reactivate(v1->2) within one second: the pre-deactivation token (v0 or v1)
    // is behind v2 -> stale; a fresh login after reactivation mints v2 -> valid. No time ambiguity.
    expect(isTokenVersionStale(0, 2)).toBe(true);
    expect(isTokenVersionStale(1, 2)).toBe(true);
    expect(isTokenVersionStale(2, 2)).toBe(false);
  });
});

describe("isAssignableCrmRole", () => {
  it("accepts the four CRM roles", () => {
    for (const r of ["admin", "director", "rep", "construction"]) expect(isAssignableCrmRole(r)).toBe(true);
  });
  it("rejects field_contractor and junk", () => {
    expect(isAssignableCrmRole("field_contractor")).toBe(false);
    expect(isAssignableCrmRole("wizard")).toBe(false);
  });
});

describe("isProhibitedSelfChange", () => {
  const base = { actorId: "u1", targetId: "u1", currentRole: "admin" as const };
  it("self + deactivate is prohibited", () => {
    expect(isProhibitedSelfChange({ ...base, nextIsActive: false })).toBe(true);
  });
  it("self + role change is prohibited", () => {
    expect(isProhibitedSelfChange({ ...base, nextRole: "rep" })).toBe(true);
  });
  it("self + no-op (same role, no active change) is allowed", () => {
    expect(isProhibitedSelfChange({ ...base, nextRole: "admin" })).toBe(false);
    expect(isProhibitedSelfChange({ ...base })).toBe(false);
  });
  it("a different user is never a self-change", () => {
    expect(isProhibitedSelfChange({ actorId: "u1", targetId: "u2", currentRole: "admin", nextIsActive: false })).toBe(false);
  });
});

describe("isFieldContractorTransition", () => {
  it("into field_contractor is blocked", () => {
    expect(isFieldContractorTransition("rep", "field_contractor")).toBe(true);
  });
  it("out of field_contractor to a CRM role is blocked", () => {
    expect(isFieldContractorTransition("field_contractor", "rep")).toBe(true);
  });
  it("CRM-to-CRM is fine", () => {
    expect(isFieldContractorTransition("rep", "director")).toBe(false);
  });
  it("undefined nextRole (no role change) is fine", () => {
    expect(isFieldContractorTransition("rep", undefined)).toBe(false);
  });
});

describe("wouldRemoveLastActiveAdmin", () => {
  it("deactivating the only admin is blocked", () => {
    expect(wouldRemoveLastActiveAdmin({ currentRole: "admin", nextIsActive: false, otherActiveAdminCount: 0 })).toBe(true);
  });
  it("demoting the only admin is blocked", () => {
    expect(wouldRemoveLastActiveAdmin({ currentRole: "admin", nextRole: "rep", otherActiveAdminCount: 0 })).toBe(true);
  });
  it("allowed when another active admin exists", () => {
    expect(wouldRemoveLastActiveAdmin({ currentRole: "admin", nextIsActive: false, otherActiveAdminCount: 1 })).toBe(false);
  });
  it("non-admin target is never the last admin", () => {
    expect(wouldRemoveLastActiveAdmin({ currentRole: "rep", nextIsActive: false, otherActiveAdminCount: 0 })).toBe(false);
  });
  it("editing an admin without dropping admin-ness is fine", () => {
    expect(wouldRemoveLastActiveAdmin({ currentRole: "admin", nextRole: "admin", otherActiveAdminCount: 0 })).toBe(false);
  });
});

describe("stripsAdminPrivilege", () => {
  it("true when an admin is deactivated or demoted", () => {
    expect(stripsAdminPrivilege("admin", undefined, false)).toBe(true);
    expect(stripsAdminPrivilege("admin", "rep", undefined)).toBe(true);
  });
  it("false for a non-admin, or an admin kept admin/active", () => {
    expect(stripsAdminPrivilege("rep", undefined, false)).toBe(false);
    expect(stripsAdminPrivilege("admin", "admin", undefined)).toBe(false);
    expect(stripsAdminPrivilege("admin", undefined, undefined)).toBe(false);
  });
});

describe("evaluateUpdateUserGuards (enforcement wiring: guard -> HTTP status)", () => {
  const base = { actorId: "actor", targetId: "target", currentRole: "rep" as const, otherActiveAdminCount: 5 };
  it("returns null when nothing is violated", () => {
    expect(evaluateUpdateUserGuards({ ...base, nextRole: "director" })).toBeNull();
  });
  it("self-change -> 403", () => {
    expect(evaluateUpdateUserGuards({ ...base, actorId: "x", targetId: "x", currentRole: "admin", nextIsActive: false })).toEqual({
      status: 403,
      message: "You can't deactivate or change your own role",
    });
  });
  it("field_contractor transition -> 403 (takes priority over admin checks)", () => {
    expect(evaluateUpdateUserGuards({ ...base, nextRole: "field_contractor" })).toEqual({
      status: 403,
      message: "Field contractors are managed in the field-user flow",
    });
  });
  it("removing the last active admin -> 409", () => {
    expect(evaluateUpdateUserGuards({ ...base, currentRole: "admin", nextIsActive: false, otherActiveAdminCount: 0 })).toEqual({
      status: 409,
      message: "Cannot remove the last active admin",
    });
  });
  it("deactivating an admin is allowed when another active admin remains", () => {
    expect(evaluateUpdateUserGuards({ ...base, currentRole: "admin", nextIsActive: false, otherActiveAdminCount: 1 })).toBeNull();
  });
  it("self-change is checked before the admin count (priority order)", () => {
    // self + last admin: self-change (403) wins over last-admin (409)
    expect(evaluateUpdateUserGuards({ actorId: "x", targetId: "x", currentRole: "admin", nextIsActive: false, otherActiveAdminCount: 0 })).toEqual({
      status: 403,
      message: "You can't deactivate or change your own role",
    });
  });
});

describe("planSessionInvalidation (effects wiring)", () => {
  it("deactivate -> bump epoch + revoke + close streams (no clear)", () => {
    expect(planSessionInvalidation({ currentIsActive: true, currentRole: "rep", nextIsActive: false })).toEqual({
      bumpVersion: true,
      revokeLocalAuth: true,
      clearLocalAuthRevocation: false,
      closeStreams: true,
    });
  });
  it("reactivate -> clear revocation AND bump epoch (kills any lingering pre-deactivation token, incl. legacy null-epoch users)", () => {
    expect(planSessionInvalidation({ currentIsActive: false, currentRole: "rep", nextIsActive: true })).toEqual({
      bumpVersion: true,
      revokeLocalAuth: false,
      clearLocalAuthRevocation: true,
      closeStreams: false,
    });
  });
  it("role change (active user) -> bump epoch AND close streams", () => {
    expect(planSessionInvalidation({ currentIsActive: true, currentRole: "rep", nextRole: "director" })).toEqual({
      bumpVersion: true,
      revokeLocalAuth: false,
      clearLocalAuthRevocation: false,
      closeStreams: true,
    });
  });
  it("no-op edit (display name only) -> no session effects", () => {
    expect(planSessionInvalidation({ currentIsActive: true, currentRole: "rep" })).toEqual({
      bumpVersion: false,
      revokeLocalAuth: false,
      clearLocalAuthRevocation: false,
      closeStreams: false,
    });
  });
  it("deactivate AND role change still bumps once (boolean OR)", () => {
    const plan = planSessionInvalidation({ currentIsActive: true, currentRole: "rep", nextIsActive: false, nextRole: "director" });
    expect(plan.bumpVersion).toBe(true);
    expect(plan.revokeLocalAuth).toBe(true);
    expect(plan.closeStreams).toBe(true);
  });
});
