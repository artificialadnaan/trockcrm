import { describe, expect, it } from "vitest";
import type { Request, Response } from "express";
import { requireAdminOrGlobalAdmin } from "../../src/middleware/rbac.js";
import { AppError } from "../../src/middleware/error-handler.js";
import type { AuthenticatedUser } from "@trock-crm/shared/types";

// Drive the middleware directly and capture what it passes to next().
function run(user: Partial<AuthenticatedUser> | undefined) {
  let nextArg: unknown = "NOT_CALLED";
  const req = { user } as unknown as Request;
  const next = (err?: unknown) => {
    nextArg = err === undefined ? null : err;
  };
  requireAdminOrGlobalAdmin(req, {} as Response, next as never);
  return nextArg;
}

const base = { id: "u1", email: "u@x", displayName: "U", officeId: "o1", activeOfficeId: "o1" };

describe("requireAdminOrGlobalAdmin", () => {
  it("ALLOWS a global admin acting in an office where they are NOT admin (Edward's case): effective role rep, base role admin", () => {
    // Edward is a global admin (baseRole admin) but holds a non-admin override in the deal's office, so
    // authMiddleware set effective role='rep'. Sharing photos must still work for a global admin.
    const result = run({ ...base, role: "rep", baseRole: "admin" });
    expect(result).toBeNull();
  });

  it("ALLOWS an office-scoped admin (effective role admin, base role rep) — no regression for office admins", () => {
    const result = run({ ...base, role: "admin", baseRole: "rep" });
    expect(result).toBeNull();
  });

  it("ALLOWS a plain global admin (role admin, base role admin)", () => {
    const result = run({ ...base, role: "admin", baseRole: "admin" });
    expect(result).toBeNull();
  });

  it("DENIES a non-admin everywhere (effective rep, base rep) -> 403", () => {
    const result = run({ ...base, role: "rep", baseRole: "rep" });
    expect(result).toBeInstanceOf(AppError);
    expect((result as AppError).statusCode).toBe(403);
  });

  it("DENIES a director (effective director, base director) -> 403", () => {
    const result = run({ ...base, role: "director", baseRole: "director" });
    expect(result).toBeInstanceOf(AppError);
    expect((result as AppError).statusCode).toBe(403);
  });

  it("401s with no authenticated user", () => {
    const result = run(undefined);
    expect(result).toBeInstanceOf(AppError);
    expect((result as AppError).statusCode).toBe(401);
  });
});
