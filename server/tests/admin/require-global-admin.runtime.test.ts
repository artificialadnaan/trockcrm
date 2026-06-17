import { describe, expect, it } from "vitest";
import type { Request, Response } from "express";
import { requireGlobalAdmin } from "../../src/middleware/rbac.js";
import { AppError } from "../../src/middleware/error-handler.js";
import type { AuthenticatedUser } from "@trock-crm/shared/types";

// Drive the middleware directly and capture what it passes to next().
function run(user: Partial<AuthenticatedUser> | undefined) {
  let nextArg: unknown = "NOT_CALLED";
  const req = { user } as unknown as Request;
  const next = (err?: unknown) => {
    nextArg = err === undefined ? null : err;
  };
  requireGlobalAdmin(req, {} as Response, next as never);
  return nextArg;
}

const base = { id: "u1", email: "u@x", displayName: "U", officeId: "o1", activeOfficeId: "o1" };

describe("requireGlobalAdmin", () => {
  it("DENIES an office-scoped admin override: effective role admin but base role rep -> 403", () => {
    // This is the #740 escalation: authMiddleware set role='admin' from a per-office override, but the
    // user's HOME role is rep. The global-admin gate must read baseRole, not role.
    const result = run({ ...base, role: "admin", baseRole: "rep" });
    expect(result).toBeInstanceOf(AppError);
    expect((result as AppError).statusCode).toBe(403);
  });

  it("ALLOWS a real global admin (baseRole admin)", () => {
    const result = run({ ...base, role: "admin", baseRole: "admin" });
    expect(result).toBeNull();
  });

  it("DENIES when baseRole is absent (fail-closed)", () => {
    const result = run({ ...base, role: "admin" });
    expect(result).toBeInstanceOf(AppError);
    expect((result as AppError).statusCode).toBe(403);
  });

  it("401s with no authenticated user", () => {
    const result = run(undefined);
    expect(result).toBeInstanceOf(AppError);
    expect((result as AppError).statusCode).toBe(401);
  });
});
