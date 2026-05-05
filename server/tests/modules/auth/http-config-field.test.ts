import { describe, expect, it } from "vitest";
import { getAllowedCorsOrigins, isAllowedCookieAuthOrigin } from "../../../src/modules/auth/http-config.js";

describe("field app auth HTTP config", () => {
  it("allows the configured field frontend origins for CORS and cookie auth", () => {
    const env = {
      FIELD_FRONTEND_URL: "https://field.trockconstruction.com/",
      RAILWAY_SERVICE_FIELD_FRONTEND_URL: "trockcrm-field.up.railway.app",
    };

    expect(getAllowedCorsOrigins(env)).toEqual(expect.arrayContaining([
      "https://field.trockconstruction.com",
      "https://trockcrm-field.up.railway.app",
      "http://localhost:5174",
    ]));
    expect(isAllowedCookieAuthOrigin(env, "https://field.trockconstruction.com")).toBe(true);
  });
});
