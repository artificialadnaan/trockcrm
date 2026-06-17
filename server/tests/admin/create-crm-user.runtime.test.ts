import { describe, expect, it } from "vitest";
import { assertCreatableCrmUser } from "../../src/modules/admin/users-service.js";

describe("assertCreatableCrmUser (create-flow validation)", () => {
  const ok = { email: "new@trock.dev", displayName: "New User", role: "rep", officeId: "00000000-0000-0000-0000-000000000001" };
  it("accepts a valid CRM user", () => {
    expect(() => assertCreatableCrmUser(ok)).not.toThrow();
  });
  it("rejects field_contractor with 400", () => {
    expect(() => assertCreatableCrmUser({ ...ok, role: "field_contractor" })).toThrowError(/field-user flow/i);
  });
  it("rejects an unknown role with 400", () => {
    expect(() => assertCreatableCrmUser({ ...ok, role: "wizard" })).toThrow();
  });
  it("rejects a blank email", () => {
    expect(() => assertCreatableCrmUser({ ...ok, email: "  " })).toThrow();
  });
  it("rejects a malformed email server-side (the dialog isn't a <form>, so type=email isn't a backstop)", () => {
    expect(() => assertCreatableCrmUser({ ...ok, email: "not-an-email" })).toThrowError(/valid email/i);
    expect(() => assertCreatableCrmUser({ ...ok, email: "a@b" })).toThrow();
    expect(() => assertCreatableCrmUser({ ...ok, email: "a b@x.com" })).toThrow();
  });
  it("rejects a blank display name", () => {
    expect(() => assertCreatableCrmUser({ ...ok, displayName: "" })).toThrow();
  });
  it("rejects a missing office", () => {
    expect(() => assertCreatableCrmUser({ ...ok, officeId: "" })).toThrow();
  });
  it("rejects a malformed officeId UUID server-side (400, not a DB 22P02 500)", () => {
    expect(() => assertCreatableCrmUser({ ...ok, officeId: "not-a-uuid" })).toThrowError(/office is invalid/i);
  });
  it("rejects a malformed reportsTo UUID but allows it absent/empty", () => {
    expect(() => assertCreatableCrmUser({ ...ok, reportsTo: "nope" })).toThrowError(/manager is invalid/i);
    expect(() => assertCreatableCrmUser({ ...ok, reportsTo: null })).not.toThrow();
    expect(() => assertCreatableCrmUser({ ...ok, reportsTo: "" })).not.toThrow();
    expect(() => assertCreatableCrmUser({ ...ok, reportsTo: "00000000-0000-0000-0000-000000000002" })).not.toThrow();
  });
});
