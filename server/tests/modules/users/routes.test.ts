import { beforeEach, describe, expect, it, vi } from "vitest";

const listUsersMock = vi.hoisted(() => vi.fn());

vi.mock("../../../src/modules/admin/users-service.js", () => ({
  listUsers: listUsersMock,
}));

const { userRoutes } = await import("../../../src/modules/users/routes.js");

function findGetRoute(path: string) {
  return (userRoutes as any).stack.find((layer: any) => layer.route?.path === path && layer.route?.methods?.get);
}

describe("user routes", () => {
  beforeEach(() => {
    listUsersMock.mockReset();
  });

  it("lists all active CRM-eligible owners without office scoping", async () => {
    listUsersMock.mockResolvedValue([
      {
        id: "rep-1",
        displayName: "Dallas Rep",
        email: "dallas@example.com",
        role: "rep",
        officeId: "office-dallas",
        isActive: true,
      },
      {
        id: "rep-2",
        displayName: "Atlanta Rep",
        email: "atlanta@example.com",
        role: "rep",
        officeId: "office-atlanta",
        isActive: true,
      },
      {
        id: "field-1",
        displayName: "Field Contractor",
        email: "field@example.com",
        role: "field_contractor",
        officeId: "office-dallas",
        isActive: true,
      },
      {
        id: "inactive-1",
        displayName: "Inactive Rep",
        email: "inactive@example.com",
        role: "rep",
        officeId: "office-dallas",
        isActive: false,
      },
    ]);

    const route = findGetRoute("/crm-owners");
    expect(route, "expected /crm-owners GET route to be registered").toBeTruthy();

    let statusCode = 200;
    let body: unknown;
    const req = {
      user: {
        id: "00000000-0000-4000-8000-000000000001",
        role: "rep",
        activeOfficeId: "office-a",
        officeId: "office-a",
      },
      commitTransaction: vi.fn(async () => undefined),
    };
    const res = {
      status(code: number) {
        statusCode = code;
        return res;
      },
      json(payload: unknown) {
        body = payload;
        return res;
      },
    };
    const next = vi.fn();

    await route.route.stack[0].handle(req, res, next);

    expect(statusCode).toBe(200);
    expect(next).not.toHaveBeenCalled();
    expect(listUsersMock).toHaveBeenCalledWith();
    expect(req.commitTransaction).toHaveBeenCalled();
    expect((body as any).users).toEqual([
      { id: "rep-1", displayName: "Dallas Rep", email: "dallas@example.com", officeId: "office-dallas" },
      { id: "rep-2", displayName: "Atlanta Rep", email: "atlanta@example.com", officeId: "office-atlanta" },
    ]);
  });
});
