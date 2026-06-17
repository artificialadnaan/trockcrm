import { describe, it, expect } from "vitest";
import { shouldRedirectToLoginOnUnauthorized, SESSION_INVALIDATED_CODE } from "./api";

// The over-redirect guard: a deactivated/role-changed/token-version-bumped session (the per-request
// recheck returns 401 + SESSION_INVALIDATED) must bounce to login; nothing else may.
describe("shouldRedirectToLoginOnUnauthorized", () => {
  it("redirects on a session-invalidated 401", () => {
    expect(shouldRedirectToLoginOnUnauthorized({ status: 401, code: SESSION_INVALIDATED_CODE, pathname: "/dashboard" })).toBe(true);
  });

  it("does NOT redirect on a permission 403 (even if it somehow carried the code)", () => {
    expect(shouldRedirectToLoginOnUnauthorized({ status: 403, code: SESSION_INVALIDATED_CODE, pathname: "/dashboard" })).toBe(false);
  });

  it("does NOT redirect on a generic 401 without the marker (ordinary/refreshable auth)", () => {
    expect(shouldRedirectToLoginOnUnauthorized({ status: 401, code: undefined, pathname: "/dashboard" })).toBe(false);
    expect(shouldRedirectToLoginOnUnauthorized({ status: 401, code: "SOME_OTHER_CODE", pathname: "/dashboard" })).toBe(false);
  });

  it("does NOT redirect when already on /login (no loop)", () => {
    expect(shouldRedirectToLoginOnUnauthorized({ status: 401, code: SESSION_INVALIDATED_CODE, pathname: "/login" })).toBe(false);
  });
});
