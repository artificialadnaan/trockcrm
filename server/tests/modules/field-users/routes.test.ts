import { beforeEach, describe, expect, it, vi } from "vitest";

const fieldUserMocks = vi.hoisted(() => ({
  acceptFieldInvite: vi.fn(),
  inviteFieldUser: vi.fn(),
  listFieldUsers: vi.fn(),
  loginFieldUser: vi.fn(),
  previewFieldInvite: vi.fn(),
  resendFieldUserInvite: vi.fn(),
  revokeFieldUserInvite: vi.fn(),
  setFieldUserActive: vi.fn(),
}));

vi.mock("../../../src/modules/field-users/service.js", () => fieldUserMocks);
vi.mock("../../../src/middleware/rate-limit.js", () => ({
  authLimiter: (_req: any, _res: any, next: (err?: unknown) => void) => next(),
}));
vi.mock("../../../src/middleware/rbac.js", () => ({
  requireAdmin: (req: any, _res: any, next: (err?: unknown) => void) => req.user?.role === "admin" ? next() : next(new Error("admin required")),
}));

const { fieldUserAdminRouter, fieldUserAuthRouter } = await import("../../../src/modules/field-users/routes.js");

function findRoute(router: any, method: string, path: string) {
  const layer = router.stack.find((entry: any) => entry.route?.path === path && entry.route?.methods?.[method]);
  if (!layer) throw new Error(`Route not found: ${method.toUpperCase()} ${path}`);
  return layer.route.stack.map((entry: any) => entry.handle);
}

async function invokeHandlers(handlers: Array<(req: any, res: any, next: (err?: unknown) => void) => unknown>, req: Record<string, any>) {
  req.headers ??= {};
  req.hostname ??= "localhost";
  req.get ??= (name: string) => req.headers?.[name.toLowerCase()];

  const res: Record<string, any> = {
    statusCode: 200,
    body: undefined,
    cookies: {} as Record<string, string>,
    locals: {},
    status(code: number) {
      res.statusCode = code;
      return res;
    },
    cookie(name: string, value: string) {
      res.cookies[name] = value;
      return res;
    },
    json(payload: any) {
      res.body = payload;
      return res;
    },
  };
  let nextError: unknown;
  for (const handler of handlers) {
    let advanced = false;
    await handler(req, res, (err?: unknown) => {
      nextError = err;
      advanced = !err;
    });
    if (nextError) break;
    if (!advanced && res.body !== undefined) break;
  }
  return { res, nextError };
}

describe("field user routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fieldUserMocks.inviteFieldUser.mockResolvedValue({ invite: { id: "invite-1", email: "field@example.com", expiresAt: "2026-05-12" } });
    fieldUserMocks.listFieldUsers.mockResolvedValue({ users: [], total: 0, page: 1, perPage: 25 });
    fieldUserMocks.resendFieldUserInvite.mockResolvedValue({ invite: { id: "invite-1", email: "field@example.com", expiresAt: "2026-05-12" } });
    fieldUserMocks.revokeFieldUserInvite.mockResolvedValue({ invite: { id: "invite-1", email: "field@example.com", expiresAt: "2026-05-12" } });
    fieldUserMocks.setFieldUserActive.mockResolvedValue({ user: { id: "field-1", active: false } });
    fieldUserMocks.acceptFieldInvite.mockResolvedValue({ user: { id: "field-1" }, token: "jwt" });
    fieldUserMocks.loginFieldUser.mockResolvedValue({ user: { id: "field-1" }, token: "jwt" });
    fieldUserMocks.previewFieldInvite.mockResolvedValue({
      firstName: "Field",
      lastName: "User",
      email: "field@example.com",
    });
  });

  it("requires admin and passes tenant context when inviting field users", async () => {
    const handlers = findRoute(fieldUserAdminRouter, "post", "/invite");
    const req = {
      body: { email: "field@example.com", firstName: "Field", lastName: "User", phone: "555" },
      user: { id: "admin-1", role: "admin", activeOfficeId: "office-1", officeId: "office-1" },
    };

    const { res, nextError } = await invokeHandlers(handlers, req);

    expect(nextError).toBeUndefined();
    expect(fieldUserMocks.inviteFieldUser).toHaveBeenCalledWith({
      email: "field@example.com",
      firstName: "Field",
      lastName: "User",
      phone: "555",
      tenantId: "office-1",
      invitedByUserId: "admin-1",
    });
    expect(res.statusCode).toBe(201);
  });

  it("lists, resends, revokes, deactivates, and reactivates field users", async () => {
    await invokeHandlers(findRoute(fieldUserAdminRouter, "get", "/"), {
      query: { search: "field", status: "active", page: "2", perPage: "10" },
      user: { id: "admin-1", role: "admin", activeOfficeId: "office-1", officeId: "office-1" },
    });
    await invokeHandlers(findRoute(fieldUserAdminRouter, "post", "/:id/resend-invite"), {
      params: { id: "invite-1" },
      user: { id: "admin-1", role: "admin", activeOfficeId: "office-1", officeId: "office-1" },
    });
    await invokeHandlers(findRoute(fieldUserAdminRouter, "post", "/invites/:id/revoke"), {
      params: { id: "invite-1" },
      user: { id: "admin-1", role: "admin", activeOfficeId: "office-1", officeId: "office-1" },
    });
    await invokeHandlers(findRoute(fieldUserAdminRouter, "post", "/:id/deactivate"), {
      params: { id: "field-1" },
      user: { id: "admin-1", role: "admin", activeOfficeId: "office-1", officeId: "office-1" },
    });
    await invokeHandlers(findRoute(fieldUserAdminRouter, "post", "/:id/reactivate"), {
      params: { id: "field-1" },
      user: { id: "admin-1", role: "admin", activeOfficeId: "office-1", officeId: "office-1" },
    });

    expect(fieldUserMocks.listFieldUsers).toHaveBeenCalledWith(expect.objectContaining({ tenantId: "office-1", search: "field", status: "active", page: 2, perPage: 10 }));
    expect(fieldUserMocks.resendFieldUserInvite).toHaveBeenCalledWith({ id: "invite-1", tenantId: "office-1" });
    expect(fieldUserMocks.revokeFieldUserInvite).toHaveBeenCalledWith({ inviteId: "invite-1", tenantId: "office-1" });
    expect(fieldUserMocks.setFieldUserActive).toHaveBeenCalledWith({ userId: "field-1", tenantId: "office-1", active: false });
    expect(fieldUserMocks.setFieldUserActive).toHaveBeenCalledWith({ userId: "field-1", tenantId: "office-1", active: true });
  });

  it("accepts field invites and sets a token cookie", async () => {
    const { res } = await invokeHandlers(findRoute(fieldUserAuthRouter, "post", "/accept-invite"), {
      body: { token: "raw", password: "correct-password-12" },
    });

    expect(fieldUserMocks.acceptFieldInvite).toHaveBeenCalledWith({ token: "raw", password: "correct-password-12" });
    expect(res.cookies.token).toBe("jwt");
    expect(res.body.token).toBe("jwt");
  });

  it("logs field users in through the field-only endpoint", async () => {
    const { res } = await invokeHandlers(findRoute(fieldUserAuthRouter, "post", "/field-login"), {
      body: { email: "field@example.com", password: "correct-password-12" },
    });

    expect(fieldUserMocks.loginFieldUser).toHaveBeenCalledWith({ email: "field@example.com", password: "correct-password-12" });
    expect(res.cookies.token).toBe("jwt");
  });

  it("previews valid field invites without consuming them", async () => {
    const { res } = await invokeHandlers(findRoute(fieldUserAuthRouter, "get", "/invite-preview"), {
      query: { token: "raw" },
    });

    expect(fieldUserMocks.previewFieldInvite).toHaveBeenCalledWith({ token: "raw" });
    expect(res.body).toEqual({
      firstName: "Field",
      lastName: "User",
      email: "field@example.com",
    });
  });
});
