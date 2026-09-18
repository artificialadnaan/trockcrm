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

    // THE APEX HOST IS PRESENT ALONGSIDE THE WILDCARD, and that is the point of this test's name.
    // R2 presigns against `<account>.r2.cloudflarestorage.com` itself, and `https://*.<account>...`
    // matches subdomains only — never the apex. The policy therefore admitted a host nothing serves
    // from and refused the one every presigned URL uses, for uploads and playback alike.
    expect(csp?.connectSrc).toEqual([
      "'self'",
      "https://*.account123.r2.cloudflarestorage.com",
      "https://account123.r2.cloudflarestorage.com",
      "https://api.example.com",
      "https://api-production-ad218.up.railway.app",
    ]);
    expect(csp?.mediaSrc).toEqual([
      "'self'",
      "https://*.account123.r2.cloudflarestorage.com",
      "https://account123.r2.cloudflarestorage.com",
    ]);
    expect(csp?.imgSrc).toEqual([
      "'self'",
      "https://*.account123.r2.cloudflarestorage.com",
      "https://account123.r2.cloudflarestorage.com",
      "data:",
    ]);
    expect(csp?.scriptSrc).toEqual(["'self'", "https://static.cloudflareinsights.com"]);
  });
});
