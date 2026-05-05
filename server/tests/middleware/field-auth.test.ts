import type { NextFunction, Request, Response } from "express";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  verifyJwt: vi.fn(),
  getUserById: vi.fn(),
}));

vi.mock("../../src/modules/auth/service.js", () => ({
  verifyJwt: mocks.verifyJwt,
  getUserById: mocks.getUserById,
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
  });

  it("allows active field contractors and attaches req.fieldUser", async () => {
    const req = createRequest();
    const next = vi.fn() as NextFunction;

    await requireFieldContractor(req, {} as Response, next);

    expect(next).toHaveBeenCalledWith();
    expect(req.user).toMatchObject({ id: "user-1", role: "field_contractor" });
    expect(req.fieldUser).toMatchObject({
      id: "user-1",
      firstName: "Field",
      lastName: "User",
      tenantId: "office-1",
      active: true,
    });
  });

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

  it("rejects CRM users and inactive field contractors with 403", async () => {
    mocks.getUserById.mockResolvedValueOnce(createUser({ role: "admin" }));
    const crmNext = vi.fn() as NextFunction;

    await requireFieldContractor(createRequest(), {} as Response, crmNext);

    expect(crmNext.mock.calls[0]?.[0]).toMatchObject({ statusCode: 403 });

    mocks.getUserById.mockResolvedValueOnce(createUser({ isActive: false }));
    const inactiveNext = vi.fn() as NextFunction;

    await requireFieldContractor(createRequest(), {} as Response, inactiveNext);

    expect(inactiveNext.mock.calls[0]?.[0]).toMatchObject({ statusCode: 403 });
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
