import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { getMcpSessionSecret } from "../../../src/mcp/auth/secret.js";

const ORIGINAL_NODE_ENV = process.env.NODE_ENV;
const ORIGINAL_MCP_SECRET = process.env.MCP_SESSION_SECRET;
const ORIGINAL_JWT_SECRET = process.env.JWT_SECRET;

describe("getMcpSessionSecret", () => {
  beforeEach(() => {
    delete process.env.MCP_SESSION_SECRET;
    delete process.env.JWT_SECRET;
  });

  afterEach(() => {
    process.env.NODE_ENV = ORIGINAL_NODE_ENV;
    if (ORIGINAL_MCP_SECRET === undefined) delete process.env.MCP_SESSION_SECRET;
    else process.env.MCP_SESSION_SECRET = ORIGINAL_MCP_SECRET;
    if (ORIGINAL_JWT_SECRET === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = ORIGINAL_JWT_SECRET;
  });

  it("returns the configured MCP_SESSION_SECRET when set", () => {
    process.env.NODE_ENV = "production";
    process.env.MCP_SESSION_SECRET = "super-secret-mcp-value";
    expect(getMcpSessionSecret()).toBe("super-secret-mcp-value");
  });

  it("throws when missing outside local development/test", () => {
    process.env.NODE_ENV = "production";
    expect(() => getMcpSessionSecret()).toThrow(/MCP_SESSION_SECRET/);
  });

  it("falls back to a dev placeholder in development/test", () => {
    process.env.NODE_ENV = "test";
    expect(getMcpSessionSecret()).toMatch(/dev/i);
  });

  it("never reuses the user-auth JWT secret or its dev fallback", () => {
    process.env.NODE_ENV = "test";
    process.env.JWT_SECRET = "the-user-auth-secret";
    expect(getMcpSessionSecret()).not.toBe("the-user-auth-secret");
    // distinct from the user-auth module's own dev fallback ("dev-secret-change-in-production")
    expect(getMcpSessionSecret()).not.toBe("dev-secret-change-in-production");
  });

  it("fails fast when MCP_SESSION_SECRET is set equal to JWT_SECRET", () => {
    process.env.NODE_ENV = "production";
    const shared = "the-same-secret-for-both";
    process.env.MCP_SESSION_SECRET = shared;
    process.env.JWT_SECRET = shared;
    expect(() => getMcpSessionSecret()).toThrow(/distinct from JWT_SECRET/);
  });
});
