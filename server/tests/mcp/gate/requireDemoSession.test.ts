import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { Request, Response, NextFunction } from "express";
import { requireDemoSession } from "../../../src/mcp/gate/requireDemoSession.js";
import { DEMO_SESSION_COOKIE, signDemoSession } from "../../../src/mcp/gate/demoSession.js";
import { CSRF_COOKIE_NAME, CSRF_HEADER_NAME } from "../../../src/modules/auth/http-config.js";

const ORIGINAL = process.env.MCP_SESSION_SECRET;

function run(opts: {
  method?: string;
  cookies?: Record<string, string>;
  headers?: Record<string, string>;
}) {
  const headers = opts.headers ?? {};
  const req = {
    method: opts.method ?? "GET",
    cookies: opts.cookies ?? {},
    get: (name: string) => headers[name.toLowerCase()],
  } as unknown as Request;
  const res = {} as Response;
  const next = vi.fn() as unknown as NextFunction;
  requireDemoSession(req, res, next);
  return next as unknown as ReturnType<typeof vi.fn>;
}
const errorOf = (next: ReturnType<typeof vi.fn>) => next.mock.calls[0]?.[0];

describe("requireDemoSession", () => {
  beforeEach(() => {
    process.env.MCP_SESSION_SECRET = "test-require-demo-secret";
  });
  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.MCP_SESSION_SECRET;
    else process.env.MCP_SESSION_SECRET = ORIGINAL;
  });

  it("401s when no demo session cookie is present", () => {
    expect(errorOf(run({}))?.statusCode).toBe(401);
  });

  it("401s when the demo session cookie is invalid", () => {
    expect(errorOf(run({ cookies: { [DEMO_SESSION_COOKIE]: "garbage" } }))?.statusCode).toBe(401);
  });

  it("passes a safe (GET) request with a valid session, no CSRF needed", () => {
    const next = run({ cookies: { [DEMO_SESSION_COOKIE]: signDemoSession() } });
    expect(errorOf(next)).toBeUndefined();
  });

  it("403s an unsafe (POST) request with a valid session but missing/mismatched CSRF", () => {
    const next = run({
      method: "POST",
      cookies: { [DEMO_SESSION_COOKIE]: signDemoSession(), [CSRF_COOKIE_NAME]: "abc" },
      headers: { [CSRF_HEADER_NAME]: "xyz" },
    });
    expect(errorOf(next)?.statusCode).toBe(403);
  });

  it("passes an unsafe (POST) request with a valid session and a matching CSRF pair", () => {
    const next = run({
      method: "POST",
      cookies: { [DEMO_SESSION_COOKIE]: signDemoSession(), [CSRF_COOKIE_NAME]: "match-token" },
      headers: { [CSRF_HEADER_NAME]: "match-token" },
    });
    expect(errorOf(next)).toBeUndefined();
  });
});
