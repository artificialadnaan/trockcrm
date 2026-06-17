// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { isGlobalAdmin } from "./roles";

// Client mirror of the server's base-role gate: admin-page access follows the HOME role, never the
// office-effective role (which a per-office role_override can change). This is what keeps the client
// in agreement with requireGlobalAdmin on the server.
describe("isGlobalAdmin", () => {
  it("is true for a global admin even when the office-effective role is non-admin (override)", () => {
    expect(isGlobalAdmin({ baseRole: "admin", role: "rep" })).toBe(true);
    expect(isGlobalAdmin({ baseRole: "admin", role: "director" })).toBe(true);
  });
  it("is FALSE for an office-override 'admin' whose home role is not admin (no client escalation)", () => {
    expect(isGlobalAdmin({ baseRole: "rep", role: "admin" })).toBe(false);
    expect(isGlobalAdmin({ baseRole: "director", role: "admin" })).toBe(false);
  });
  it("falls back to effective role when baseRole is absent (right after login, where they're equal)", () => {
    expect(isGlobalAdmin({ role: "admin" })).toBe(true);
    expect(isGlobalAdmin({ role: "rep" })).toBe(false);
  });
  it("is false for no user", () => {
    expect(isGlobalAdmin(null)).toBe(false);
    expect(isGlobalAdmin(undefined)).toBe(false);
  });
});
