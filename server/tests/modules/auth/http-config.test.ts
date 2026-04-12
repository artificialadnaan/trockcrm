import { describe, expect, it } from "vitest";
import {
  getAllowedCorsOrigins,
  getTokenCookieOptions,
  isDevAuthEnabled,
} from "../../../src/modules/auth/http-config.js";

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

  it("uses secure lax cookie settings in production", () => {
    expect(getTokenCookieOptions({ NODE_ENV: "production" })).toMatchObject({
      httpOnly: true,
      secure: true,
      sameSite: "lax",
    });
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

  it("allows dev auth remotely when explicit testing mode is enabled", () => {
    expect(
      isDevAuthEnabled(
        {
          NODE_ENV: "production",
          AZURE_CLIENT_ID: "",
          DEV_MODE: "true",
        },
        "crm.trockconstruction.com"
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
});
