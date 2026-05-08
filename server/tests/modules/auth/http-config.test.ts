import { describe, expect, it } from "vitest";
import {
  assertSafeDevAuthConfig,
  createCsrfToken,
  FIELD_CSRF_HEADER_VALUE,
  getAllowedCorsOrigins,
  getLogoutCookieClears,
  getRequestOrigin,
  getTokenCookieOptions,
  isAllowedCookieAuthOrigin,
  isFieldApiPath,
  isPublicAuthCsrfExempt,
  isValidFieldCsrfHeader,
  isValidCsrfPair,
  isDevAuthEnabled,
} from "../../../src/modules/auth/http-config.js";

describe("auth http config", () => {
  it("includes the configured custom frontend and Railway frontend service origins", () => {
    expect(
      getAllowedCorsOrigins({
        CORS_ALLOWED_ORIGINS: "https://crm.trockconstruction.com, https://trockcrm.com, https://crm.trockconstruction.com",
        FRONTEND_URL: "https://frontend-production-bcab.up.railway.app",
        RAILWAY_PUBLIC_DOMAIN: "trockcrm.com",
        RAILWAY_STATIC_URL: "trockcrm.com",
        RAILWAY_SERVICE_FRONTEND_URL: "frontend-production-bcab.up.railway.app",
      })
    ).toEqual([
      "https://crm.trockconstruction.com",
      "https://trockcrm.com",
      "https://frontend-production-bcab.up.railway.app",
      "http://localhost:5173",
      "http://localhost:5174",
      "http://localhost:3000",
    ]);
  });

  it("uses secure cross-site cookie settings in production", () => {
    expect(getTokenCookieOptions({ NODE_ENV: "production" })).toMatchObject({
      httpOnly: true,
      secure: true,
      sameSite: "lax",
      domain: ".trockcrm.com",
    });
  });

  it("clears shared and host-only auth cookies on logout", () => {
    expect(
      getLogoutCookieClears({ NODE_ENV: "production", AUTH_COOKIE_DOMAIN: ".trockcrm.com" }).map((clear) => [
        clear.name,
        "domain" in clear.options ? clear.options.domain : null,
        clear.options.path,
        clear.options.maxAge,
      ])
    ).toEqual([
      ["token", ".trockcrm.com", "/", 0],
      ["token", null, "/", 0],
      ["csrf_token", ".trockcrm.com", "/", 0],
      ["csrf_token", null, "/", 0],
    ]);
  });

  it("uses strict non-secure cookies in development", () => {
    expect(getTokenCookieOptions({ NODE_ENV: "development" })).toMatchObject({
      httpOnly: true,
      secure: false,
      sameSite: "strict",
    });
  });

  it("allows dev auth on localhost during local development when Azure SSO is not configured", () => {
    expect(
      isDevAuthEnabled(
        {
          NODE_ENV: "development",
          AZURE_CLIENT_ID: "",
        },
        "localhost"
      )
    ).toBe(true);
  });

  it("requires explicit testing mode to stay on local development hosts", () => {
    expect(
      isDevAuthEnabled(
        {
          NODE_ENV: "development",
          AZURE_CLIENT_ID: "",
          DEV_MODE: "true",
        },
        "crm.trockconstruction.com"
      )
    ).toBe(false);
  });

  it("allows explicit testing mode on localhost during development", () => {
    expect(
      isDevAuthEnabled(
        {
          NODE_ENV: "development",
          AZURE_CLIENT_ID: "",
          DEV_MODE: "true",
        },
        "localhost:3001"
      )
    ).toBe(true);
  });

  it("disables dev auth in production when testing mode is not explicitly enabled", () => {
    expect(
      isDevAuthEnabled(
        {
          NODE_ENV: "production",
          AZURE_CLIENT_ID: "",
        },
        "crm.trockconstruction.com"
      )
    ).toBe(false);
  });

  it("fails startup when production enables DEV_MODE", () => {
    expect(() =>
      assertSafeDevAuthConfig({
        NODE_ENV: "production",
        DEV_MODE: "true",
      })
    ).toThrow("DEV_MODE=true is not allowed");
  });

  it("allows startup when production dev auth has the explicit pre-cutover override", () => {
    expect(() =>
      assertSafeDevAuthConfig({
        NODE_ENV: "production",
        DEV_MODE: "true",
        ALLOW_DEV_AUTH_IN_PROD: "true",
        FIELD_APP_URL: "https://trockcrm-field-production.up.railway.app",
      })
    ).not.toThrow();
  });

  it("keeps hard-failing production DEV_MODE when the pre-cutover override is false", () => {
    expect(() =>
      assertSafeDevAuthConfig({
        NODE_ENV: "production",
        DEV_MODE: "true",
        ALLOW_DEV_AUTH_IN_PROD: "false",
      })
    ).toThrow("DEV_MODE=true is not allowed");
  });

  it("enables dev auth endpoints in production only when the pre-cutover override is present", () => {
    expect(
      isDevAuthEnabled(
        {
          NODE_ENV: "production",
          DEV_MODE: "true",
          ALLOW_DEV_AUTH_IN_PROD: "true",
        },
        "crm.trockconstruction.com"
      )
    ).toBe(true);
  });

  it("allows only exact configured origins for cookie-authenticated unsafe requests", () => {
    const env = {
      CORS_ALLOWED_ORIGINS: "https://crm.trockconstruction.com, http://localhost:3001",
    };

    expect(isAllowedCookieAuthOrigin(env, "https://crm.trockconstruction.com")).toBe(true);
    expect(isAllowedCookieAuthOrigin(env, "https://evil.example.com")).toBe(false);
    expect(isAllowedCookieAuthOrigin(env, "https://crm.trockconstruction.com.evil.example.com")).toBe(false);
    expect(isAllowedCookieAuthOrigin(env, null)).toBe(false);
  });

  it("normalizes Origin before falling back to Referer", () => {
    expect(getRequestOrigin({ origin: "http://localhost:3001/" })).toBe("http://localhost:3001");
    expect(getRequestOrigin({ referer: "http://localhost:3001/deals/123" })).toBe("http://localhost:3001");
    expect(getRequestOrigin({ referer: "not-a-url" })).toBeNull();
  });

  it("validates matching CSRF cookie and header tokens", () => {
    const token = createCsrfToken();
    expect(isValidCsrfPair(token, token)).toBe(true);
    expect(isValidCsrfPair(token, createCsrfToken())).toBe(false);
    expect(isValidCsrfPair(undefined, token)).toBe(false);
    expect(isValidCsrfPair(token, undefined)).toBe(false);
  });

  it("identifies field API paths and validates the field requested-with header", () => {
    expect(isFieldApiPath("/api/field")).toBe(true);
    expect(isFieldApiPath("/api/field/projects/deal-1/star")).toBe(true);
    expect(isFieldApiPath("/api/fielding/projects")).toBe(false);
    expect(isFieldApiPath("/api/files/deal-1/photos")).toBe(false);

    expect(isValidFieldCsrfHeader(FIELD_CSRF_HEADER_VALUE)).toBe(true);
    expect(isValidFieldCsrfHeader("fetch")).toBe(false);
    expect(isValidFieldCsrfHeader(undefined)).toBe(false);
  });

  it("exempts only exact public auth POST endpoints from CSRF", () => {
    const env = { NODE_ENV: "test", DEV_MODE: "true" };

    expect(isPublicAuthCsrfExempt({ method: "POST", path: "/api/auth/accept-invite", env })).toBe(true);
    expect(isPublicAuthCsrfExempt({ method: "POST", path: "/api/auth/field-login", env })).toBe(true);
    expect(isPublicAuthCsrfExempt({ method: "POST", path: "/api/auth/local/login", env })).toBe(true);
    expect(
      isPublicAuthCsrfExempt({
        method: "POST",
        path: "/api/auth/dev/login",
        host: "localhost:5174",
        env,
      })
    ).toBe(true);

    expect(isPublicAuthCsrfExempt({ method: "GET", path: "/api/auth/accept-invite", env })).toBe(false);
    expect(isPublicAuthCsrfExempt({ method: "POST", path: "/api/auth/accept-invite/extra", env })).toBe(false);
    expect(isPublicAuthCsrfExempt({ method: "POST", path: "/api/auth/logout", env })).toBe(true);
    expect(isPublicAuthCsrfExempt({ method: "POST", path: "/api/auth/local/change-password", env })).toBe(false);
    expect(
      isPublicAuthCsrfExempt({
        method: "POST",
        path: "/api/auth/dev/login",
        host: "crm.trockconstruction.com",
        env: { NODE_ENV: "production", DEV_MODE: "false" },
      })
    ).toBe(false);
  });
});
