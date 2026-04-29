import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";

const ORIGINAL_ENV = { ...process.env };

describe("security CSP", () => {
  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it("allows browser uploads and playback against R2 presigned URLs", async () => {
    process.env.R2_ACCOUNT_ID = "account123";
    process.env.R2_CSP_DOMAIN = "";
    process.env.CSP_CONNECT_SRC = "https://api.example.com, https://api.example.com";

    const { createApp } = await import("../../src/app.js");
    const response = await request(createApp()).get("/api/health");
    const csp = response.headers["content-security-policy"];

    expect(csp).toContain("connect-src 'self' https://*.account123.r2.cloudflarestorage.com https://api.example.com");
    expect(csp).toContain("media-src 'self' https://*.account123.r2.cloudflarestorage.com");
    expect(csp).toContain("img-src 'self' https://*.account123.r2.cloudflarestorage.com data:");
    expect(csp).toContain("script-src 'self' https://static.cloudflareinsights.com");
  });
});
