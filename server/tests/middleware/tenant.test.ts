import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Request, Response, NextFunction } from "express";
import { requireRole, requireAdmin, requireDirector } from "../../src/middleware/rbac.js";
import { AppError } from "../../src/middleware/error-handler.js";
import type { AuthenticatedUser } from "@trock-crm/shared/types";

function mockReq(user?: Partial<AuthenticatedUser>): Partial<Request> {
  return {
    user: user
      ? {
          id: "test-id",
          email: "test@trock.dev",
          displayName: "Test User",
          role: "rep",
          officeId: "office-1",
          activeOfficeId: "office-1",
          ...user,
        }
      : undefined,
  };
}

function mockRes(): Partial<Response> {
  return {};
}

describe("rbac middleware", () => {
  it("requireRole should call next() for an allowed role", () => {
    const middleware = requireRole("admin", "director");
    const next = vi.fn();
    middleware(
      mockReq({ role: "admin" }) as Request,
      mockRes() as Response,
      next
    );
    expect(next).toHaveBeenCalledOnce();
    expect(next).toHaveBeenCalledWith(); // called with no args = success
  });

  it("requireRole should call next(AppError) for a disallowed role", () => {
    const middleware = requireRole("admin", "director");
    const next = vi.fn();
    middleware(
      mockReq({ role: "rep" }) as Request,
      mockRes() as Response,
      next
    );
    expect(next).toHaveBeenCalledOnce();
    const err = next.mock.calls[0][0];
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).statusCode).toBe(403);
  });

  it("requireRole should return 401 when no user is on the request", () => {
    const middleware = requireRole("admin");
    const next = vi.fn();
    middleware(
      mockReq() as Request,
      mockRes() as Response,
      next
    );
    expect(next).toHaveBeenCalledOnce();
    const err = next.mock.calls[0][0];
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).statusCode).toBe(401);
  });

  it("requireAdmin should only allow admin role", () => {
    const next = vi.fn();
    requireAdmin(mockReq({ role: "admin" }) as Request, mockRes() as Response, next);
    expect(next).toHaveBeenCalledWith(); // success

    const next2 = vi.fn();
    requireAdmin(mockReq({ role: "director" }) as Request, mockRes() as Response, next2);
    const err = next2.mock.calls[0][0];
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).statusCode).toBe(403);
  });

  it("requireDirector should allow admin and director", () => {
    const nextAdmin = vi.fn();
    requireDirector(mockReq({ role: "admin" }) as Request, mockRes() as Response, nextAdmin);
    expect(nextAdmin).toHaveBeenCalledWith();

    const nextDirector = vi.fn();
    requireDirector(mockReq({ role: "director" }) as Request, mockRes() as Response, nextDirector);
    expect(nextDirector).toHaveBeenCalledWith();

    const nextRep = vi.fn();
    requireDirector(mockReq({ role: "rep" }) as Request, mockRes() as Response, nextRep);
    const err = nextRep.mock.calls[0][0];
    expect(err).toBeInstanceOf(AppError);
  });
});

describe("tenant middleware", () => {
  it("should reject requests without authentication", async () => {
    // Import dynamically to avoid DB connection on module load
    const { tenantMiddleware } = await import("../../src/middleware/tenant.js");
    const req = mockReq() as Request; // no user
    const res = mockRes() as Response;
    const next = vi.fn();

    await tenantMiddleware(req, res, next);

    expect(next).toHaveBeenCalledOnce();
    const err = next.mock.calls[0][0];
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).statusCode).toBe(401);
  });
});
