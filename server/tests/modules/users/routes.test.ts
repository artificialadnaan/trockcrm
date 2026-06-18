import { beforeEach, describe, expect, it, vi } from "vitest";

const listUsersMock = vi.hoisted(() => vi.fn());
const getAccessibleOfficesMock = vi.hoisted(() => vi.fn());

vi.mock("../../../src/modules/admin/users-service.js", () => ({
  listUsers: listUsersMock,
}));
vi.mock("../../../src/modules/auth/service.js", () => ({
  getAccessibleOffices: getAccessibleOfficesMock,
}));

const { userRoutes } = await import("../../../src/modules/users/routes.js");

function findGetRoute(path: string) {
  return (userRoutes as any).stack.find((layer: any) => layer.route?.path === path && layer.route?.methods?.get);
}

describe("user routes", () => {
  beforeEach(() => {
    listUsersMock.mockReset();
    getAccessibleOfficesMock.mockReset();
    getAccessibleOfficesMock.mockResolvedValue([{ id: "office-a" }]);
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

  it("keeps /sales-reps narrow by default for non-admin reps", async () => {
    const route = findGetRoute("/sales-reps");
    expect(route, "expected /sales-reps GET route to be registered").toBeTruthy();

    let body: unknown;
    const req = {
      query: {},
      headers: {},
      user: {
        id: "rep-1",
        role: "rep",
        displayName: "Current Rep",
        email: "current@example.com",
        activeOfficeId: "office-a",
        officeId: "office-a",
      },
      commitTransaction: vi.fn(async () => undefined),
    };
    const res = {
      json(payload: unknown) {
        body = payload;
        return res;
      },
    };
    const next = vi.fn();

    await route.route.stack[0].handle(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(listUsersMock).not.toHaveBeenCalled();
    expect(req.commitTransaction).toHaveBeenCalled();
    expect((body as any).users).toEqual([
      { id: "rep-1", displayName: "Current Rep", email: "current@example.com" },
    ]);
  });

  // CONVENTION SHIFT (was "lists active same-office reassignment candidates"): the picker now INCLUDES
  // multi-office grant-holders. listUsers(officeId) already returns "office_id = officeId OR has a
  // user_office_access grant to it", and the reassignment (#748) + estimator (validateAssignee) backends
  // ACCEPT grant-holders — so the route must NOT re-filter them out by primary officeId, or a valid
  // candidate (here `rep-access-only`, primary office-b, granted office-a) is un-pickable in the UI even
  // though the PATCH would accept the id. Inactive rows are still dropped.
  it("lists active office-accessible reassignment candidates incl. multi-office grant-holders", async () => {
    listUsersMock.mockResolvedValue([
      {
        id: "rep-1",
        displayName: "Current Rep",
        email: "current@example.com",
        role: "rep",
        officeId: "office-a",
        isActive: true,
      },
      {
        id: "rep-2",
        displayName: "Next Rep",
        email: "next@example.com",
        role: "rep",
        officeId: "office-a",
        isActive: true,
      },
      {
        // Primary office-b, but listUsers returned this row for the office-a query → holds a grant to
        // office-a. Must now appear in the picker (the backend accepts grant-holders as assignees/estimators).
        id: "rep-access-only",
        displayName: "Access Only Rep",
        email: "access-only@example.com",
        role: "rep",
        officeId: "office-b",
        isActive: true,
      },
      {
        id: "inactive-1",
        displayName: "Inactive Rep",
        email: "inactive@example.com",
        role: "rep",
        officeId: "office-a",
        isActive: false,
      },
    ]);

    const route = findGetRoute("/sales-reps");
    let body: unknown;
    const req = {
      query: { purpose: "deal-reassignment" },
      headers: {},
      user: {
        id: "rep-1",
        role: "rep",
        displayName: "Current Rep",
        email: "current@example.com",
        activeOfficeId: "office-a",
        officeId: "office-a",
      },
      commitTransaction: vi.fn(async () => undefined),
    };
    const res = {
      json(payload: unknown) {
        body = payload;
        return res;
      },
    };
    const next = vi.fn();

    await route.route.stack[0].handle(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(getAccessibleOfficesMock).toHaveBeenCalledWith("rep-1", "rep", "office-a");
    expect(listUsersMock).toHaveBeenCalledWith("office-a");
    expect(req.commitTransaction).toHaveBeenCalled();
    expect((body as any).users).toEqual([
      { id: "rep-1", displayName: "Current Rep", email: "current@example.com" },
      { id: "rep-2", displayName: "Next Rep", email: "next@example.com" },
      { id: "rep-access-only", displayName: "Access Only Rep", email: "access-only@example.com" },
    ]);
  });
});
