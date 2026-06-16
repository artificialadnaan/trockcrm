import { describe, expect, it } from "vitest";
import { isAssignableCrmRole } from "@trock-crm/shared/types";
import {
  isTokenStaleByEpoch,
  isProhibitedSelfChange,
  isFieldContractorTransition,
  wouldRemoveLastActiveAdmin,
} from "@trock-crm/shared/lib/userProvisioningGuards";

describe("isTokenStaleByEpoch", () => {
  it("null epoch is never stale", () => {
    expect(isTokenStaleByEpoch(1000, null)).toBe(false);
  });
  it("token issued strictly before the epoch is stale", () => {
    expect(isTokenStaleByEpoch(1000, 1000 * 1000 + 1)).toBe(true);
  });
  it("token issued at/after the epoch is valid", () => {
    expect(isTokenStaleByEpoch(1000, 1000 * 1000)).toBe(false);
    expect(isTokenStaleByEpoch(2000, 1000 * 1000)).toBe(false);
  });
  it("undefined iat is not stale (cannot prove staleness)", () => {
    expect(isTokenStaleByEpoch(undefined, 1000 * 1000)).toBe(false);
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
