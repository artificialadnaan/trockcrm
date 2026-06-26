import { describe, it, expect, beforeEach, afterEach } from "vitest";
import jwt from "jsonwebtoken";
import {
  DEMO_SESSION_TTL_SECONDS,
  isValidDemoSession,
  signDemoSession,
} from "../../../src/mcp/gate/demoSession.js";
import { getMcpSessionSecret } from "../../../src/mcp/auth/secret.js";

const ORIGINAL = process.env.MCP_SESSION_SECRET;

describe("demo session cookie", () => {
  beforeEach(() => {
    process.env.MCP_SESSION_SECRET = "test-demo-session-secret";
  });
  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.MCP_SESSION_SECRET;
    else process.env.MCP_SESSION_SECRET = ORIGINAL;
  });

  it("accepts a freshly signed session", () => {
    expect(isValidDemoSession(signDemoSession())).toBe(true);
  });

  it("rejects undefined / empty", () => {
    expect(isValidDemoSession(undefined)).toBe(false);
    expect(isValidDemoSession("")).toBe(false);
    expect(isValidDemoSession("not-a-jwt")).toBe(false);
  });

  it("rejects a session signed with another secret", () => {
    const forged = jwt.sign({ demo: true }, "other-secret", {
      algorithm: "HS256",
      audience: "trock-ai-demo-session",
      expiresIn: 3600,
    });
    expect(isValidDemoSession(forged)).toBe(false);
  });

  it("rejects an MCP token (wrong audience) — the two token families don't cross", () => {
    const mcpAud = jwt.sign({ office: "office_dallas" }, getMcpSessionSecret(), {
      algorithm: "HS256",
      audience: "trock-mcp",
      expiresIn: 300,
    });
    expect(isValidDemoSession(mcpAud)).toBe(false);
  });

  it("rejects an expired session", () => {
    const expired = jwt.sign({ demo: true }, getMcpSessionSecret(), {
      algorithm: "HS256",
      audience: "trock-ai-demo-session",
      expiresIn: -10,
    });
    expect(isValidDemoSession(expired)).toBe(false);
  });

  it("uses a multi-hour TTL (human session, not the 300s machine token)", () => {
    expect(DEMO_SESSION_TTL_SECONDS).toBeGreaterThanOrEqual(3600);
  });
});
