import { describe, expect, it } from "vitest";
import {
  assertSafeDevAuthConfig,
  getAllowedCorsOrigins,
  getFieldAppUrl,
  isAllowedCookieAuthOrigin,
} from "../../../src/modules/auth/http-config.js";

describe("field app auth HTTP config", () => {
  it("allows the configured field frontend origins for CORS and cookie auth", () => {
    const env = {
      FIELD_APP_URL: "https://field-app.trockcrm.com/",
      FIELD_FRONTEND_URL: "https://field.trockconstruction.com/",
      RAILWAY_SERVICE_FIELD_FRONTEND_URL: "trockcrm-field.up.railway.app",
    };

    expect(getAllowedCorsOrigins(env)).toEqual(expect.arrayContaining([
      "https://field-app.trockcrm.com",
      "https://field.trockconstruction.com",
      "https://trockcrm-field.up.railway.app",
      "http://localhost:5174",
    ]));
    expect(isAllowedCookieAuthOrigin(env, "https://field.trockconstruction.com")).toBe(true);
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
  });
});
