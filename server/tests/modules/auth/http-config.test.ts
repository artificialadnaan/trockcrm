import { describe, expect, it } from "vitest";
import {
  assertSafeDevAuthConfig,
  createCsrfToken,
  FIELD_CSRF_HEADER_VALUE,
  getAllowedCorsOrigins,
  getCsrfCookieOptions,
  getCsrfCookieOptionsForRequest,
  getDevAuthProductionWarning,
  getLegacyTokenCookieClearsForRequest,
  getLogoutCookieClears,
  getLogoutCookieClearsForRequest,
  getRequestOrigin,
  getStrictCrossSiteAuthOrigins,
  getTokenCookieOptions,
  getTokenCookieOptionsForRequest,
  isAllowedCookieAuthOrigin,
  isFieldApiPath,
  isPublicAuthCsrfExempt,
  shouldExposeCsrfTokenInResponse,
  isValidFieldCsrfHeader,
  isValidCsrfPair,
  isDevAuthEnabled,
  isDevAuthProductionOverrideEnabled,
} from "../../../src/modules/auth/http-config.js";

describe("auth http config", () => {
  const fallbackApiHost = ["api-production-ad218", "up.railway.app"].join(".");

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

  it("omits localhost and http origins from the production credentialed CORS allowlist", () => {
    expect(
      getAllowedCorsOrigins({
        NODE_ENV: "production",
        CORS_ALLOWED_ORIGINS: "https://trockcrm.com, http://localhost:5173, http://insecure.example.com",
      })
    ).toEqual(["https://trockcrm.com"]);
  });

  it("keeps localhost in the non-production CORS allowlist for local workflows", () => {
    expect(
      getAllowedCorsOrigins({
        NODE_ENV: "development",
        CORS_ALLOWED_ORIGINS: "https://crm.example.com",
      })
    ).toEqual([
      "https://crm.example.com",
      "http://localhost:5173",
      "http://localhost:5174",
      "http://localhost:3000",
    ]);
  });

  it("defaults strict cross-site auth origins to empty until production env explicitly opts in", () => {
    expect(getStrictCrossSiteAuthOrigins({ NODE_ENV: "production" })).toEqual([
    ]);
  });

  it("treats the field app public origin as a default strict cross-site auth origin when present", () => {
    expect(
      getStrictCrossSiteAuthOrigins({
        NODE_ENV: "production",
        RAILWAY_SERVICE_TROCKCRM_FIELD_URL: "trockcam.com",
      })
    ).toEqual(["https://trockcam.com"]);
  });

  it("does not implicitly trust legacy field frontend hosts for strict cross-site auth", () => {
    expect(
      getStrictCrossSiteAuthOrigins({
        NODE_ENV: "production",
        FIELD_FRONTEND_URL: "https://legacy-field.example.com",
        RAILWAY_SERVICE_FIELD_FRONTEND_URL: "trockcrm-field.up.railway.app",
        RAILWAY_SERVICE_TROCKCRM_FIELD_URL: "trockcam.com",
        FIELD_APP_URL: "https://field-app.trockcrm.com",
      })
    ).toEqual([
      "https://trockcam.com",
      "https://field-app.trockcrm.com",
    ]);
  });

  it("accepts explicit production HTTPS strict cross-site auth origins", () => {
    expect(
      getStrictCrossSiteAuthOrigins({
        NODE_ENV: "production",
        STRICT_CROSS_SITE_AUTH_ORIGINS:
          "https://trockcrm.com,https://crm.trockconstruction.com,https://frontend-production-bcab.up.railway.app",
      })
    ).toEqual([
      "https://trockcrm.com",
      "https://crm.trockconstruction.com",
      "https://frontend-production-bcab.up.railway.app",
    ]);
  });

  it("merges configured strict cross-site auth origins with the field app defaults", () => {
    expect(
      getStrictCrossSiteAuthOrigins({
        NODE_ENV: "production",
        RAILWAY_SERVICE_TROCKCRM_FIELD_URL: "trockcam.com",
        STRICT_CROSS_SITE_AUTH_ORIGINS:
          "https://crm.trockconstruction.com,https://frontend-production-bcab.up.railway.app",
      })
    ).toEqual([
      "https://trockcam.com",
      "https://crm.trockconstruction.com",
      "https://frontend-production-bcab.up.railway.app",
    ]);
  });

  it("ignores non-https and localhost strict cross-site auth origins in production", () => {
    expect(
      getStrictCrossSiteAuthOrigins({
        NODE_ENV: "production",
        STRICT_CROSS_SITE_AUTH_ORIGINS:
          "https://frontend-production-bcab.up.railway.app,http://localhost:5173,http://insecure.example.com",
      })
    ).toEqual(["https://frontend-production-bcab.up.railway.app"]);
  });

  it("uses secure cross-site cookie settings in production", () => {
    expect(getTokenCookieOptions({ NODE_ENV: "production" })).toMatchObject({
      httpOnly: true,
      secure: true,
      sameSite: "lax",
      domain: ".trockcrm.com",
      path: "/",
    });
  });

  it("sets readable CSRF cookies on the shared production auth domain", () => {
    expect(getCsrfCookieOptions({ NODE_ENV: "production" })).toMatchObject({
      httpOnly: false,
      secure: true,
      sameSite: "lax",
      domain: ".trockcrm.com",
      path: "/",
    });
  });

  it("omits the shared cookie domain for Railway API fallback hosts", () => {
    const tokenOptions = getTokenCookieOptionsForRequest(
      {
        NODE_ENV: "production",
        AUTH_COOKIE_DOMAIN: ".trockcrm.com",
        CORS_ALLOWED_ORIGINS: "https://frontend-production-bcab.up.railway.app",
        STRICT_CROSS_SITE_AUTH_ORIGINS: "https://frontend-production-bcab.up.railway.app",
      },
      {
        host: fallbackApiHost,
        origin: "https://frontend-production-bcab.up.railway.app",
      }
    );
    const csrfOptions = getCsrfCookieOptionsForRequest(
      {
        NODE_ENV: "production",
        AUTH_COOKIE_DOMAIN: ".trockcrm.com",
        CORS_ALLOWED_ORIGINS: "https://frontend-production-bcab.up.railway.app",
        STRICT_CROSS_SITE_AUTH_ORIGINS: "https://frontend-production-bcab.up.railway.app",
      },
      {
        host: fallbackApiHost,
        origin: "https://frontend-production-bcab.up.railway.app",
      }
    );

    expect(tokenOptions).toMatchObject({
      httpOnly: true,
      secure: true,
      sameSite: "none",
      path: "/",
      partitioned: true,
    });
    expect(csrfOptions).toMatchObject({
      httpOnly: false,
      secure: true,
      sameSite: "none",
      path: "/",
      partitioned: true,
    });
    expect(tokenOptions).not.toHaveProperty("domain");
    expect(csrfOptions).not.toHaveProperty("domain");
  });

  it("uses SameSite=Lax for localhost origins in production even if localhost is listed", () => {
    const tokenOptions = getTokenCookieOptionsForRequest(
      {
        NODE_ENV: "production",
        CORS_ALLOWED_ORIGINS: "http://localhost:5173",
        STRICT_CROSS_SITE_AUTH_ORIGINS: "https://frontend-production-bcab.up.railway.app",
      },
      {
        host: fallbackApiHost,
        origin: "http://localhost:5173",
      }
    );

    expect(tokenOptions).toMatchObject({
      secure: true,
      sameSite: "lax",
      path: "/",
    });
  });

  it("uses SameSite=None only for explicit production HTTPS cross-site auth origins", () => {
    const tokenOptions = getTokenCookieOptionsForRequest(
      {
        NODE_ENV: "production",
        CORS_ALLOWED_ORIGINS: "https://frontend-production-bcab.up.railway.app",
        STRICT_CROSS_SITE_AUTH_ORIGINS: "https://frontend-production-bcab.up.railway.app",
      },
      {
        host: fallbackApiHost,
        origin: "https://frontend-production-bcab.up.railway.app",
      }
    );

    expect(tokenOptions).toMatchObject({
      secure: true,
      sameSite: "none",
      path: "/",
      partitioned: true,
    });
  });

  it("keeps the shared cookie domain on canonical trockcrm.com requests", () => {
    expect(
      getTokenCookieOptionsForRequest(
        { NODE_ENV: "production", AUTH_COOKIE_DOMAIN: ".trockcrm.com" },
        { host: "trockcrm.com", origin: "https://trockcrm.com" }
      )
    ).toMatchObject({
      domain: ".trockcrm.com",
      sameSite: "lax",
      path: "/",
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

  it("clears fallback API host cookies with cross-site attributes on logout", () => {
    const clears = getLogoutCookieClearsForRequest(
      {
        NODE_ENV: "production",
        AUTH_COOKIE_DOMAIN: ".trockcrm.com",
        CORS_ALLOWED_ORIGINS: "https://frontend-production-bcab.up.railway.app",
        STRICT_CROSS_SITE_AUTH_ORIGINS: "https://frontend-production-bcab.up.railway.app",
      },
      {
        host: fallbackApiHost,
        origin: "https://frontend-production-bcab.up.railway.app",
      }
    );

    expect(clears.map((clear) => [
      clear.name,
      "domain" in clear.options ? clear.options.domain : null,
      clear.options.sameSite,
      "partitioned" in clear.options ? clear.options.partitioned : false,
      clear.options.maxAge,
    ])).toEqual([
      ["token", null, "none", false, 0],
      ["token", null, "none", true, 0],
      ["token", null, "none", false, 0],
      ["token", null, "none", true, 0],
      ["csrf_token", null, "none", false, 0],
      ["csrf_token", null, "none", true, 0],
    ]);
  });

  it("clears both root and legacy /api/auth token variants during cross-site auth refresh", () => {
    const clears = getLegacyTokenCookieClearsForRequest(
      {
        NODE_ENV: "production",
        AUTH_COOKIE_DOMAIN: ".trockcrm.com",
        RAILWAY_SERVICE_TROCKCRM_FIELD_URL: "trockcam.com",
        STRICT_CROSS_SITE_AUTH_ORIGINS: "https://crm.trockconstruction.com",
      },
      {
        host: fallbackApiHost,
        origin: "https://trockcam.com",
      }
    );

    expect(clears.map((clear) => [
      clear.name,
      clear.options.path,
      "partitioned" in clear.options ? clear.options.partitioned : false,
      clear.options.sameSite,
      clear.options.maxAge,
    ])).toEqual([
      ["token", "/", false, "none", 0],
      ["token", "/", true, "none", 0],
      ["token", "/api/auth", false, "none", 0],
      ["token", "/api/auth", true, "none", 0],
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

  it("keeps startup closed when production dev auth lacks the explicit acknowledgement", () => {
    expect(() =>
      assertSafeDevAuthConfig({
        NODE_ENV: "production",
        DEV_MODE: "true",
        ALLOW_DEV_AUTH_IN_PROD: "true",
        FIELD_APP_URL: "https://trockcrm-field-production.up.railway.app",
      })
    ).toThrow("I_UNDERSTAND_DEV_AUTH_IN_PROD=yes");
  });

  it("allows startup when production dev auth has both explicit overrides", () => {
    expect(() =>
      assertSafeDevAuthConfig({
        NODE_ENV: "production",
        DEV_MODE: "true",
        ALLOW_DEV_AUTH_IN_PROD: "true",
        I_UNDERSTAND_DEV_AUTH_IN_PROD: "yes",
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

  it("does not enable dev auth endpoints in production when acknowledgement is absent", () => {
    expect(
      isDevAuthEnabled(
        {
          NODE_ENV: "production",
          DEV_MODE: "true",
          ALLOW_DEV_AUTH_IN_PROD: "true",
        },
        "crm.trockconstruction.com"
      )
    ).toBe(false);
    expect(
      isDevAuthProductionOverrideEnabled({
        NODE_ENV: "production",
        DEV_MODE: "true",
        ALLOW_DEV_AUTH_IN_PROD: "true",
      })
    ).toBe(false);
  });

  it("enables dev auth endpoints in production only when both production overrides are present", () => {
    expect(
      isDevAuthEnabled(
        {
          NODE_ENV: "production",
          DEV_MODE: "true",
          ALLOW_DEV_AUTH_IN_PROD: "true",
          I_UNDERSTAND_DEV_AUTH_IN_PROD: "yes",
        },
        "crm.trockconstruction.com"
      )
    ).toBe(true);
  });

  it("returns a loud warning when production dev auth is explicitly enabled", () => {
    expect(
      getDevAuthProductionWarning({
        NODE_ENV: "production",
        DEV_MODE: "true",
        ALLOW_DEV_AUTH_IN_PROD: "true",
        I_UNDERSTAND_DEV_AUTH_IN_PROD: "yes",
      })
    ).toContain("[AUTH][PRODUCTION DEV AUTH ENABLED]");
    expect(
      getDevAuthProductionWarning({
        NODE_ENV: "production",
        DEV_MODE: "true",
        ALLOW_DEV_AUTH_IN_PROD: "true",
      })
    ).toBeNull();
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

  it("rejects localhost as a cookie-auth origin in production", () => {
    const env = {
      NODE_ENV: "production",
      CORS_ALLOWED_ORIGINS: "https://trockcrm.com,http://localhost:5173",
    };

    expect(isAllowedCookieAuthOrigin(env, "https://trockcrm.com")).toBe(true);
    expect(isAllowedCookieAuthOrigin(env, "http://localhost:5173")).toBe(false);
  });

  it("exposes response-body CSRF tokens only to explicit production cross-site auth origins", () => {
    const env = {
      NODE_ENV: "production",
      CORS_ALLOWED_ORIGINS: "https://frontend-production-bcab.up.railway.app",
      STRICT_CROSS_SITE_AUTH_ORIGINS: "https://frontend-production-bcab.up.railway.app",
    };

    expect(
      shouldExposeCsrfTokenInResponse(env, {
        host: fallbackApiHost,
        origin: "https://frontend-production-bcab.up.railway.app",
      })
    ).toBe(true);
    expect(
      shouldExposeCsrfTokenInResponse(env, {
        host: "trockcrm.com",
        origin: "https://trockcrm.com",
      })
    ).toBe(false);
    expect(
      shouldExposeCsrfTokenInResponse(env, {
        host: fallbackApiHost,
        origin: "http://localhost:5173",
      })
    ).toBe(false);
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
    expect(isPublicAuthCsrfExempt({ method: "POST", path: "/api/auth/logout", env })).toBe(false);
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
