import { describe, expect, it } from "vitest";
import {
  assertSafeDevAuthConfig,
  getAllowedCorsOrigins,
  getFieldAppUrl,
  getTokenCookieOptionsForRequest,
  isAllowedCookieAuthOrigin,
} from "../../../src/modules/auth/http-config.js";

describe("field app auth HTTP config", () => {
  const fallbackApiHost = ["api-production-ad218", "up.railway.app"].join(".");

  it("allows the configured field frontend origins for CORS and cookie auth", () => {
    const env = {
      FIELD_APP_URL: "https://field-app.trockcrm.com/",
      FIELD_FRONTEND_URL: "https://field.trockconstruction.com/",
      RAILWAY_SERVICE_FIELD_FRONTEND_URL: "trockcrm-field.up.railway.app",
      RAILWAY_SERVICE_TROCKCRM_FIELD_URL: "trockcam.com",
    };

    expect(getAllowedCorsOrigins(env)).toEqual(expect.arrayContaining([
      "https://field-app.trockcrm.com",
      "https://field.trockconstruction.com",
      "https://trockcrm-field.up.railway.app",
      "https://trockcam.com",
      "http://localhost:5174",
    ]));
    expect(isAllowedCookieAuthOrigin(env, "https://field.trockconstruction.com")).toBe(true);
    expect(isAllowedCookieAuthOrigin(env, "https://trockcam.com")).toBe(true);
  });

  it("accepts the Railway-managed trockcrm-field public domain env name", () => {
    const env = {
      NODE_ENV: "production",
      RAILWAY_SERVICE_TROCKCRM_FIELD_URL: "trockcam.com",
    };

    expect(getAllowedCorsOrigins(env as any)).toEqual(["https://trockcam.com"]);
    expect(isAllowedCookieAuthOrigin(env as any, "https://trockcam.com")).toBe(true);
  });

  it("uses SameSite=None for the Railway-managed trockcrm-field public domain", () => {
    expect(
      getTokenCookieOptionsForRequest(
        {
          NODE_ENV: "production",
          RAILWAY_SERVICE_TROCKCRM_FIELD_URL: "trockcam.com",
        } as any,
        {
          host: fallbackApiHost,
          origin: "https://trockcam.com",
        }
      )
    ).toMatchObject({
      secure: true,
      sameSite: "none",
    });
  });

  it("uses SameSite=None when FIELD_APP_URL is the custom trockcam.com origin", () => {
    expect(
      getTokenCookieOptionsForRequest(
        {
          NODE_ENV: "production",
          FIELD_APP_URL: "https://trockcam.com",
        },
        {
          host: fallbackApiHost,
          origin: "https://trockcam.com",
        }
      )
    ).toMatchObject({
      secure: true,
      sameSite: "none",
    });
  });

  it("requires FIELD_APP_URL for production field invite links", () => {
    expect(() => assertSafeDevAuthConfig({ NODE_ENV: "production" })).toThrow("FIELD_APP_URL is required");
    expect(() =>
      assertSafeDevAuthConfig({
        NODE_ENV: "production",
        FIELD_APP_URL: "https://trockcrm-field-production.up.railway.app",
      })
    ).not.toThrow();
  });

  it("normalizes FIELD_APP_URL and falls back to the local field app in development", () => {
    expect(getFieldAppUrl({ NODE_ENV: "development" })).toBe("http://localhost:5174");
    expect(getFieldAppUrl({ FIELD_APP_URL: "https://field.example.com/" })).toBe("https://field.example.com");
    expect(getFieldAppUrl({ RAILWAY_SERVICE_TROCKCRM_FIELD_URL: "trockcam.com" })).toBe("https://trockcam.com");
  });

  it("keeps FIELD_APP_URL as the canonical invite-link origin when multiple field URLs are configured", () => {
    expect(
      getFieldAppUrl({
        FIELD_APP_URL: "https://field.example.com/",
        RAILWAY_SERVICE_TROCKCRM_FIELD_URL: "trockcam.com",
        FIELD_FRONTEND_URL: "https://legacy-field.example.com/",
        RAILWAY_SERVICE_FIELD_FRONTEND_URL: "trockcrm-field.up.railway.app",
      })
    ).toBe("https://field.example.com");
  });
});
