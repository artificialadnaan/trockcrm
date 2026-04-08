import { describe, expect, it } from "vitest";
import { getAllowedCorsOrigins, getTokenCookieOptions } from "../../../src/modules/auth/http-config.js";

describe("auth http config", () => {
  it("includes the configured custom frontend and Railway frontend service origins", () => {
    expect(
      getAllowedCorsOrigins({
        FRONTEND_URL: "https://crm.trockconstruction.com",
        RAILWAY_SERVICE_FRONTEND_URL: "frontend-production-bcab.up.railway.app",
      })
    ).toEqual([
      "https://crm.trockconstruction.com",
      "https://frontend-production-bcab.up.railway.app",
      "http://localhost:5173",
      "http://localhost:3000",
    ]);
  });

  it("uses cross-site cookie settings in production", () => {
    expect(getTokenCookieOptions({ NODE_ENV: "production" })).toMatchObject({
      httpOnly: true,
      secure: true,
      sameSite: "none",
    });
  });

  it("uses strict non-secure cookies in development", () => {
    expect(getTokenCookieOptions({ NODE_ENV: "development" })).toMatchObject({
      httpOnly: true,
      secure: false,
      sameSite: "strict",
    });
  });
});
