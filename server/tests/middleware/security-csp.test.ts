import { afterEach, describe, expect, it } from "vitest";
import { getSecurityOptions } from "../../src/middleware/security.js";

const ORIGINAL_ENV = { ...process.env };

describe("security CSP", () => {
  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it("allows browser uploads and playback against R2 presigned URLs", async () => {
    process.env.R2_ACCOUNT_ID = "account123";
    process.env.R2_CSP_DOMAIN = "";
    process.env.CSP_CONNECT_SRC = "https://api.example.com, https://api.example.com";

    const csp = getSecurityOptions().contentSecurityPolicy?.directives;

    expect(csp?.connectSrc).toEqual([
      "'self'",
      "https://*.account123.r2.cloudflarestorage.com",
      "https://api.example.com",
      "https://api-production-ad218.up.railway.app",
    ]);
    expect(csp?.mediaSrc).toEqual(["'self'", "https://*.account123.r2.cloudflarestorage.com"]);
    expect(csp?.imgSrc).toEqual(["'self'", "https://*.account123.r2.cloudflarestorage.com", "data:"]);
    expect(csp?.scriptSrc).toEqual(["'self'", "https://static.cloudflareinsights.com"]);
  });
});
