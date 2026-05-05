import { describe, expect, it, vi } from "vitest";

vi.mock("../../../src/middleware/field-auth.js", () => ({
  requireFieldContractor: (req: any, _res: any, next: (err?: unknown) => void) => {
    req.fieldUser = {
      id: "field-1",
      email: "field@example.com",
      firstName: "Field",
      lastName: "User",
      role: "field_contractor",
      tenantId: "office-1",
      active: true,
    };
    next();
  },
}));

const { fieldRoutes } = await import("../../../src/modules/field/routes.js");

function findRoute(router: any, method: string, path: string) {
  const layer = router.stack.find((entry: any) => entry.route?.path === path && entry.route?.methods?.[method]);
  if (!layer) throw new Error(`Route not found: ${method.toUpperCase()} ${path}`);
  return layer.route.stack.map((entry: any) => entry.handle);
}

describe("field routes", () => {
  it("returns the authenticated field contractor profile", async () => {
    const handlers = findRoute(fieldRoutes, "get", "/me");
    const req: Record<string, unknown> = {};
    const res: Record<string, unknown> = {
      body: undefined,
      json(payload: unknown) {
        res.body = payload;
        return res;
      },
    };

    for (const handler of handlers) {
      await handler(req, res, (err?: unknown) => {
        if (err) throw err;
      });
    }

    expect(res.body).toEqual({
      user: {
        id: "field-1",
        email: "field@example.com",
        firstName: "Field",
        lastName: "User",
        role: "field_contractor",
        tenantId: "office-1",
        active: true,
      },
    });
  });
});
