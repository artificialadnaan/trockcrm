import type { NextFunction, Request, Response } from "express";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  verifyJwt: vi.fn(),
  getUserById: vi.fn(),
  getOfficeAccess: vi.fn(),
  getUserLocalAuthGate: vi.fn(),
}));

vi.mock("../../src/modules/auth/service.js", () => ({
  verifyJwt: mocks.verifyJwt,
  getUserById: mocks.getUserById,
  getOfficeAccess: mocks.getOfficeAccess,
}));

vi.mock("../../src/modules/auth/local-auth-service.js", () => ({
  getUserLocalAuthGate: mocks.getUserLocalAuthGate,
}));

const { requireCrmUser, requireFieldContractor } = await import("../../src/middleware/field-auth.js");

function createRequest(overrides: Partial<Request> = {}) {
  return {
    cookies: { token: "jwt-token" },
    headers: {},
    ...overrides,
  } as Request;
}

function createUser(overrides: Record<string, unknown> = {}) {
  return {
    id: "user-1",
    email: "field@example.com",
    displayName: "Field User",
    firstName: "Field",
    lastName: "User",
    role: "field_contractor",
    officeId: "office-1",
    isActive: true,
    ...overrides,
  };
}

describe("field auth middleware", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.verifyJwt.mockReturnValue({ userId: "user-1", authMethod: "local" });
    mocks.getUserById.mockResolvedValue(createUser());
    mocks.getOfficeAccess.mockResolvedValue({ hasAccess: true });
    mocks.getUserLocalAuthGate.mockResolvedValue({
      mustChangePassword: false,
      isEnabled: true,
      inviteExpiresAt: null,
      lockedUntil: null,
      revokedAt: null,
    });
  });

  it.each(["field_contractor", "admin", "director", "rep", "construction"] as const)(
    "allows active %s users and attaches req.fieldUser",
    async (role) => {
      mocks.getUserById.mockResolvedValueOnce(createUser({ role }));
      const req = createRequest();
      const next = vi.fn() as NextFunction;

      await requireFieldContractor(req, {} as Response, next);

      expect(next).toHaveBeenCalledWith();
      expect(req.user).toMatchObject({ id: "user-1", role });
      expect(req.fieldUser).toMatchObject({
        id: "user-1",
        firstName: "Field",
        lastName: "User",
        role,
        tenantId: "office-1",
        active: true,
      });
    }
  );

  it("rejects missing and invalid field tokens with 401", async () => {
    const missingReq = createRequest({ cookies: {}, headers: {} });
    const missingNext = vi.fn() as NextFunction;

    await requireFieldContractor(missingReq, {} as Response, missingNext);

    expect(missingNext.mock.calls[0]?.[0]).toMatchObject({ statusCode: 401 });

    mocks.verifyJwt.mockImplementationOnce(() => {
      throw new Error("bad token");
    });
    const invalidNext = vi.fn() as NextFunction;

    await requireFieldContractor(createRequest(), {} as Response, invalidNext);

    expect(invalidNext.mock.calls[0]?.[0]).toMatchObject({ statusCode: 401 });
  });

  it("rejects inactive and unsupported field users with 403", async () => {
    mocks.getUserById.mockResolvedValueOnce(createUser({ isActive: false }));
    const inactiveNext = vi.fn() as NextFunction;

    await requireFieldContractor(createRequest(), {} as Response, inactiveNext);

    expect(inactiveNext.mock.calls[0]?.[0]).toMatchObject({ statusCode: 403 });

    mocks.getUserById.mockResolvedValueOnce(createUser({ role: "sales_manager" }));
    const unsupportedNext = vi.fn() as NextFunction;

    await requireFieldContractor(createRequest(), {} as Response, unsupportedNext);

    expect(unsupportedNext.mock.calls[0]?.[0]).toMatchObject({ statusCode: 403 });
  });

  it("rejects local field sessions that require a password change", async () => {
    mocks.getUserLocalAuthGate.mockResolvedValueOnce({
      mustChangePassword: true,
      isEnabled: true,
      inviteExpiresAt: null,
      lockedUntil: null,
      revokedAt: null,
    });
    const next = vi.fn() as NextFunction;

    await requireFieldContractor(createRequest(), {} as Response, next);

    const error = next.mock.calls[0]?.[0];
    expect(error).toMatchObject({
      statusCode: 403,
      message: "Field app access requires password change",
    });
  });

  it("rejects revoked local field sessions", async () => {
    mocks.getUserLocalAuthGate.mockResolvedValueOnce({
      mustChangePassword: false,
      isEnabled: true,
      inviteExpiresAt: null,
      lockedUntil: null,
      revokedAt: "2026-04-20T10:00:00.000Z",
    });
    const next = vi.fn() as NextFunction;

    await requireFieldContractor(createRequest(), {} as Response, next);

    const error = next.mock.calls[0]?.[0];
    expect(error).toMatchObject({
      statusCode: 401,
      message: "Local login is no longer enabled for this user",
    });
  });

  it("preserves requested active office context for accessible CRM users", async () => {
    mocks.getUserById.mockResolvedValueOnce(createUser({ role: "admin", officeId: "office-primary" }));
    mocks.getOfficeAccess.mockResolvedValueOnce({ hasAccess: true, roleOverride: "director" });
    const req = createRequest({ headers: { "x-office-id": "office-branch" } as any });
    const next = vi.fn() as NextFunction;

    await requireFieldContractor(req, {} as Response, next);

    expect(next).toHaveBeenCalledWith();
    expect(mocks.getOfficeAccess).toHaveBeenCalledWith("user-1", "office-branch");
    expect(req.user).toMatchObject({ role: "director", officeId: "office-primary", activeOfficeId: "office-branch" });
    expect(req.fieldUser).toMatchObject({ role: "director", tenantId: "office-branch" });
  });

  it("rejects unauthorized office overrides for CRM users", async () => {
    mocks.getUserById.mockResolvedValueOnce(createUser({ role: "admin", officeId: "office-primary" }));
    mocks.getOfficeAccess.mockResolvedValueOnce({ hasAccess: false });
    const req = createRequest({ headers: { "x-office-id": "office-unauthorized" } as any });
    const next = vi.fn() as NextFunction;

    await requireFieldContractor(req, {} as Response, next);

    expect(next.mock.calls[0]?.[0]).toMatchObject({ statusCode: 403 });
  });

  it("requireCrmUser allows CRM users and rejects field contractors", () => {
    const crmNext = vi.fn() as NextFunction;
    requireCrmUser(createRequest({
      user: {
        id: "admin-1",
        email: "admin@example.com",
        displayName: "Admin",
        role: "admin",
        officeId: "office-1",
        activeOfficeId: "office-1",
      },
    }), {} as Response, crmNext);
    expect(crmNext).toHaveBeenCalledWith();

    const fieldNext = vi.fn() as NextFunction;
    requireCrmUser(createRequest({
      user: {
        id: "field-1",
        email: "field@example.com",
        displayName: "Field",
        role: "field_contractor",
        officeId: "office-1",
        activeOfficeId: "office-1",
      },
    }), {} as Response, fieldNext);
    expect(fieldNext.mock.calls[0]?.[0]).toMatchObject({ statusCode: 403 });

    const missingNext = vi.fn() as NextFunction;
    requireCrmUser(createRequest(), {} as Response, missingNext);
    expect(missingNext.mock.calls[0]?.[0]).toMatchObject({ statusCode: 401 });
  });
});
