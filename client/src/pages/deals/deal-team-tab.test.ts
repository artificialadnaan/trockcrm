import { describe, expect, it } from "vitest";
import { isValidEmailOnlyMemberEmail, validateAddMemberForm } from "./deal-team-tab";

describe("isValidEmailOnlyMemberEmail", () => {
  it("accepts a well-formed email", () => {
    expect(isValidEmailOnlyMemberEmail("ext.super@example.com")).toBe(true);
  });
  it("rejects a malformed email", () => {
    expect(isValidEmailOnlyMemberEmail("not-an-email")).toBe(false);
    expect(isValidEmailOnlyMemberEmail("missing@domain")).toBe(false);
    expect(isValidEmailOnlyMemberEmail("")).toBe(false);
  });
});

describe("validateAddMemberForm", () => {
  const base = { userId: "", hasSelectedContact: false, memberName: "", memberEmail: "" };

  it("requires a role in every mode", () => {
    expect(validateAddMemberForm({ ...base, mode: "user", role: "" })).toMatch(/role/i);
  });

  it("user mode requires a selected user", () => {
    expect(validateAddMemberForm({ ...base, mode: "user", role: "project_manager" })).toMatch(/user/i);
    expect(
      validateAddMemberForm({ ...base, mode: "user", role: "project_manager", userId: "u-1" }),
    ).toBeNull();
  });

  it("contact mode requires a selected contact", () => {
    expect(validateAddMemberForm({ ...base, mode: "contact", role: "superintendent" })).toMatch(/contact/i);
    expect(
      validateAddMemberForm({ ...base, mode: "contact", role: "superintendent", hasSelectedContact: true }),
    ).toBeNull();
  });

  it("email mode requires name, valid email, and a super/PM role", () => {
    expect(
      validateAddMemberForm({ ...base, mode: "email", role: "superintendent", memberEmail: "e@x.com" }),
    ).toMatch(/name/i);
    expect(
      validateAddMemberForm({ ...base, mode: "email", role: "superintendent", memberName: "Ext", memberEmail: "bad" }),
    ).toMatch(/valid email/i);
    expect(
      validateAddMemberForm({
        ...base,
        mode: "email",
        role: "foreman",
        memberName: "Ext",
        memberEmail: "e@x.com",
      }),
    ).toMatch(/Superintendent or Project Manager/i);
    expect(
      validateAddMemberForm({
        ...base,
        mode: "email",
        role: "project_manager",
        memberName: "Ext PM",
        memberEmail: "ext.pm@example.com",
      }),
    ).toBeNull();
  });
});
