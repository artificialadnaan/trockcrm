import { isAllowedRole, isTokenExpired, CRM_APP_ALLOWED_ROLES } from "../auth/session";

describe("CRM session role gate", () => {
  it.each(["admin", "director", "rep", "construction"])("allows %s", (role) => {
    expect(isAllowedRole(role)).toBe(true);
  });

  it("refuses field_contractor", () => {
    // Not an arbitrary exclusion: the server's requireCrmUser rejects this role on every CRM route, so
    // admitting it here would create a login that appears to succeed and then 403s on every screen.
    // T-Rock Cam's equivalent set DOES include it — the two apps have deliberately different gates.
    expect(isAllowedRole("field_contractor")).toBe(false);
    expect(CRM_APP_ALLOWED_ROLES.has("field_contractor")).toBe(false);
  });

  it.each([null, undefined, 42, "", "Admin", "superuser"])("refuses %p", (role) => {
    expect(isAllowedRole(role)).toBe(false);
  });
});

describe("isTokenExpired", () => {
  /** A JWT-shaped string whose payload carries the given exp. Signature is irrelevant — never verified. */
  function tokenWithExp(exp: number | undefined): string {
    const payload = exp === undefined ? {} : { exp };
    const b64 = Buffer.from(JSON.stringify(payload)).toString("base64url");
    return `header.${b64}.signature`;
  }

  it("treats a past exp as expired", () => {
    const now = 1_700_000_000_000;
    expect(isTokenExpired(tokenWithExp(now / 1000 - 60), now)).toBe(true);
  });

  it("treats a future exp as live", () => {
    const now = 1_700_000_000_000;
    expect(isTokenExpired(tokenWithExp(now / 1000 + 3600), now)).toBe(false);
  });

  it.each([
    ["a malformed token", "not-a-jwt"],
    ["a token with no exp claim", tokenWithExp(undefined)],
    ["an unparseable payload", "header.@@@@.signature"],
  ])("returns false for %s rather than signing the user out", (_case, token) => {
    // Fail OPEN on purpose. This is a convenience check to avoid an app-flash-then-401; the server is the
    // authority. Reporting "expired" because we could not read a token would log someone out for a
    // parsing bug, which is far worse than one wasted request that comes back 401.
    expect(isTokenExpired(token, Date.now())).toBe(false);
  });
});
