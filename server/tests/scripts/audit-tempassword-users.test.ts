import { describe, expect, it } from "vitest";
import {
  auditTempPasswordUser,
  hasValidScryptHashFormat,
  summarizeAudit,
  type PendingTempPasswordUserRow,
} from "../../../scripts/audit-tempassword-users.js";

const validHash = `scrypt$${"a".repeat(32)}$${"b".repeat(128)}`;

function row(overrides: Partial<PendingTempPasswordUserRow> = {}): PendingTempPasswordUserRow {
  return {
    user_id: "user-1",
    email: "real.user@trockgc.com",
    display_name: "Real User",
    role: "rep",
    office_id: "office-1",
    office_slug: "dallas",
    user_is_active: true,
    password_hash: validHash,
    is_enabled: true,
    revoked_at: null,
    locked_until: null,
    ...overrides,
  };
}

describe("audit-tempassword-users", () => {
  it("validates repo scrypt hash format", () => {
    expect(hasValidScryptHashFormat(validHash)).toBe(true);
    expect(hasValidScryptHashFormat("not-a-valid-hash")).toBe(false);
  });

  it("marks fully configured first-login users ready", () => {
    expect(auditTempPasswordUser(row())).toMatchObject({
      email: "real.user@trockgc.com",
      status: "ready",
      issues: [],
    });
  });

  it("separates repairable local-auth hygiene from blocked user/profile issues", () => {
    expect(auditTempPasswordUser(row({ is_enabled: false }))).toMatchObject({
      status: "repairable",
      issues: ["local_auth_disabled"],
    });
    expect(auditTempPasswordUser(row({ revoked_at: new Date("2026-05-12T12:00:00Z") }))).toMatchObject({
      status: "blocked",
      issues: ["local_auth_revoked"],
    });
    expect(auditTempPasswordUser(row({ office_id: null }))).toMatchObject({
      status: "blocked",
      issues: ["missing_office"],
    });
  });

  it("summarizes pending first-login readiness", () => {
    expect(summarizeAudit([
      auditTempPasswordUser(row()),
      auditTempPasswordUser(row({ is_enabled: false })),
      auditTempPasswordUser(row({ password_hash: "bad" })),
    ])).toEqual({
      pendingFirstLogin: 3,
      ready: 1,
      repairable: 1,
      blocked: 1,
      repaired: 0,
    });
  });

  it("keeps user ids available for explicit execute allowlists", () => {
    expect(auditTempPasswordUser(row({ user_id: "user-explicit-1" }))).toMatchObject({
      userId: "user-explicit-1",
    });
  });
});
