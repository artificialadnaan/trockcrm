import { describe, expect, it } from "vitest";
import {
  buildForcePasswordChangePlan,
  buildForcePasswordChangeUpdate,
  parseForcePasswordChangeArgs,
  summarizeForcePasswordPlan,
  type RealUserLocalAuthRow,
} from "../../../scripts/force-password-change-real-users.js";

const baseRow: RealUserLocalAuthRow = {
  user_id: "user-1",
  email: "rep@trockgc.com",
  display_name: "Rep User",
  role: "rep",
  office_slug: "dallas",
  user_is_active: true,
  must_change_password: false,
  is_enabled: true,
  revoked_at: null,
  invite_expires_at: null,
  last_login_at: "2026-05-08T21:00:00.000Z",
};

describe("force-password-change-real-users", () => {
  it("plans active non-test local-auth users with must_change_password=false", () => {
    const plan = buildForcePasswordChangePlan([baseRow]);

    expect(plan).toHaveLength(1);
    expect(plan[0]).toMatchObject({
      userId: "user-1",
      email: "rep@trockgc.com",
      role: "rep",
      office: "dallas",
      action: "force_password_change",
      clearInviteExpiresAt: false,
    });
  });

  it("skips smoke, test-domain, already-forced, inactive, revoked, disabled, and field contractor rows", () => {
    const plan = buildForcePasswordChangePlan([
      { ...baseRow, user_id: "smoke", email: "test-sales@trock.test" },
      { ...baseRow, user_id: "dev", email: "someone@trock.dev" },
      { ...baseRow, user_id: "forced", must_change_password: true },
      { ...baseRow, user_id: "inactive", user_is_active: false },
      { ...baseRow, user_id: "revoked", revoked_at: "2026-05-12T12:00:00.000Z" },
      { ...baseRow, user_id: "disabled", is_enabled: false },
      { ...baseRow, user_id: "field", role: "field_contractor" },
    ]);

    expect(plan).toEqual([]);
  });

  it("clears expired invite expiry for never-logged affected users so existing temp passwords still authenticate", () => {
    const plan = buildForcePasswordChangePlan([
      {
        ...baseRow,
        last_login_at: null,
        invite_expires_at: "2026-05-11T20:00:00.000Z",
      },
    ], new Date("2026-05-12T18:00:00.000Z"));

    expect(plan[0]).toMatchObject({
      clearInviteExpiresAt: true,
    });
  });

  it("summarizes affected rows and invite-expiry clears", () => {
    expect(summarizeForcePasswordPlan([
      { ...buildForcePasswordChangePlan([baseRow])[0]!, clearInviteExpiresAt: false },
      {
        ...buildForcePasswordChangePlan([{ ...baseRow, user_id: "user-2", email: "rep2@trockgc.com" }])[0]!,
        clearInviteExpiresAt: true,
      },
    ])).toEqual({
      affected: 2,
      clearInviteExpiresAt: 1,
    });
  });

  it("fails closed when dry-run and execute flags are both supplied", () => {
    expect(parseForcePasswordChangeArgs([])).toEqual({ execute: false });
    expect(parseForcePasswordChangeArgs(["--dry-run"])).toEqual({ execute: false });
    expect(parseForcePasswordChangeArgs(["--execute"])).toEqual({ execute: true });
    expect(() => parseForcePasswordChangeArgs(["--execute", "--dry-run"])).toThrow(
      "Use either --dry-run or --execute, not both"
    );
  });

  it("builds a narrowly scoped update that never writes password hashes", () => {
    const plan = buildForcePasswordChangePlan([
      baseRow,
      {
        ...baseRow,
        user_id: "user-2",
        email: "never-logged@trockgc.com",
        last_login_at: null,
        invite_expires_at: "2026-05-11T20:00:00.000Z",
      },
    ], new Date("2026-05-12T18:00:00.000Z"));

    const update = buildForcePasswordChangeUpdate(plan);

    expect(update?.text).toContain("must_change_password = true");
    expect(update?.text).toContain("invite_expires_at = CASE");
    expect(update?.text).toContain("INSERT INTO public.user_local_auth_events");
    expect(update?.text).toContain("password_change_forced");
    expect(update?.text).toContain("ula.is_enabled = true");
    expect(update?.text).toContain("ula.revoked_at IS NULL");
    expect(update?.text).toContain("u.is_active = true");
    expect(update?.text).not.toContain("password_hash");
    expect(update?.values).toEqual([
      ["user-2", "user-1"],
      ["user-2"],
      ["admin", "director", "rep", "construction"],
    ]);
  });

  it("does not build an update for an empty plan", () => {
    expect(buildForcePasswordChangeUpdate([])).toBeNull();
  });
});
