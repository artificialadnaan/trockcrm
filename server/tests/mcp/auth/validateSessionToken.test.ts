import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import { validateSessionToken } from "../../../src/mcp/auth/validateSessionToken.js";
import { MCP_AUDIENCE } from "../../../src/mcp/auth/contract.js";

const ORIGINAL = process.env.MCP_SESSION_SECRET;
const SECRET = "test-mcp-secret-validate";

function sign(payload: Record<string, unknown>, opts: jwt.SignOptions = {}): string {
  return jwt.sign(payload, SECRET, { algorithm: "HS256", audience: MCP_AUDIENCE, expiresIn: 300, ...opts });
}

function run(authorization?: string, extra: Partial<Request> = {}) {
  const req = { headers: authorization ? { authorization } : {}, ...extra } as Request;
  const res = {} as Response;
  const next = vi.fn() as unknown as NextFunction;
  validateSessionToken(req, res, next);
  return { req, next: next as unknown as ReturnType<typeof vi.fn> };
}

function errorOf(next: ReturnType<typeof vi.fn>) {
  return next.mock.calls[0]?.[0];
}

describe("validateSessionToken", () => {
  beforeEach(() => {
    process.env.MCP_SESSION_SECRET = SECRET;
  });
  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.MCP_SESSION_SECRET;
    else process.env.MCP_SESSION_SECRET = ORIGINAL;
  });

  it("attaches req.mcpContext and calls next() with no error for a valid token", () => {
    const { req, next } = run(`Bearer ${sign({ office: "office_dallas", scope: "read_all" })}`);
    expect(errorOf(next)).toBeUndefined();
    expect(req.mcpContext).toEqual({ office: "office_dallas", scope: "read_all" });
  });

  it("401s when the Authorization header is missing", () => {
    const { req, next } = run(undefined);
    expect(errorOf(next)?.statusCode).toBe(401);
    expect(req.mcpContext).toBeUndefined();
  });

  it("ignores cookies — only the Bearer header is honored (machine client, never browser)", () => {
    const token = sign({ office: "office_dallas", scope: "read_all" });
    const { next } = run(undefined, { cookies: { token } } as unknown as Partial<Request>);
    expect(errorOf(next)?.statusCode).toBe(401);
  });

  it("401s on a bad signature", () => {
    const forged = jwt.sign({ office: "office_dallas", scope: "read_all" }, "wrong-secret", {
      algorithm: "HS256",
      audience: MCP_AUDIENCE,
      expiresIn: 300,
    });
    expect(errorOf(run(`Bearer ${forged}`).next)?.statusCode).toBe(401);
  });

  it("401s on the wrong audience", () => {
    const token = sign({ office: "office_dallas", scope: "read_all" }, { audience: "some-other-aud" });
    expect(errorOf(run(`Bearer ${token}`).next)?.statusCode).toBe(401);
  });

  it("401s on an expired token", () => {
    const token = sign({ office: "office_dallas", scope: "read_all" }, { expiresIn: -10 });
    expect(errorOf(run(`Bearer ${token}`).next)?.statusCode).toBe(401);
  });

  it("401s when the office claim is outside the allowlist (defense-in-depth)", () => {
    const token = sign({ office: "office_evil", scope: "read_all" });
    expect(errorOf(run(`Bearer ${token}`).next)?.statusCode).toBe(401);
  });

  it("401s for an allowlisted office that is NOT Dallas (single-tenant demo)", () => {
    const token = sign({ office: "office_atlanta", scope: "read_all" });
    expect(errorOf(run(`Bearer ${token}`).next)?.statusCode).toBe(401);
  });

  it("401s for a token with no expiry claim", () => {
    const noExp = jwt.sign({ office: "office_dallas", scope: "read_all" }, SECRET, {
      algorithm: "HS256",
      audience: MCP_AUDIENCE,
    });
    expect(errorOf(run(`Bearer ${noExp}`).next)?.statusCode).toBe(401);
  });

  it("401s when the scope claim is not read_all", () => {
    const token = sign({ office: "office_dallas", scope: "write" });
    expect(errorOf(run(`Bearer ${token}`).next)?.statusCode).toBe(401);
  });
});
