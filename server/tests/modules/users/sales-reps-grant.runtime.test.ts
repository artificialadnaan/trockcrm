import { beforeEach, describe, expect, it, vi } from "vitest";

// Gate-executed (`*.runtime.test.ts`) lock for the multi-office picker fix (Codex P2): the /sales-reps
// reassignment/estimator picker must surface grant-holders. listUsers(officeId) already scopes rows to
// "office_id = officeId OR a user_office_access grant to it", and the reassignment (#748) + estimator
// (validateAssignee) backends ACCEPT grant-holders — so the route must not re-filter them out by primary
// officeId, or a valid candidate is un-pickable in the UI even though the PATCH would accept the id.
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
  return (userRoutes as any).stack.find(
    (layer: any) => layer.route?.path === path && layer.route?.methods?.get
  );
}

async function invokeSalesReps(reqOverrides: Record<string, unknown> = {}) {
  const route = findGetRoute("/sales-reps");
  let body: unknown;
  const req = {
    query: { purpose: "deal-reassignment" },
    headers: {},
    user: {
      id: "director-1",
      role: "director",
      displayName: "Director",
      email: "director@example.com",
      activeOfficeId: "office-a",
      officeId: "office-a",
    },
    commitTransaction: vi.fn(async () => undefined),
    ...reqOverrides,
  };
  const res = {
    json(payload: unknown) {
      body = payload;
      return res;
    },
  };
  const next = vi.fn();
  await route.route.stack[0].handle(req, res, next);
  return { body, next, req };
}

describe("/sales-reps picker — multi-office grant-holders (runtime)", () => {
  beforeEach(() => {
    listUsersMock.mockReset();
    getAccessibleOfficesMock.mockReset();
    getAccessibleOfficesMock.mockResolvedValue([{ id: "office-a" }]);
  });

  it("includes a grant-only multi-office candidate (primary office differs) in the picker", async () => {
    listUsersMock.mockResolvedValue([
      { id: "rep-1", displayName: "Primary Rep", email: "primary@example.com", role: "rep", officeId: "office-a", isActive: true },
      // Primary office-b, returned for the office-a query → holds a grant to office-a. Must be pickable.
      { id: "grant-rep", displayName: "Grant Rep", email: "grant@example.com", role: "rep", officeId: "office-b", isActive: true },
    ]);

    const { body, next } = await invokeSalesReps();

    expect(next).not.toHaveBeenCalled();
    expect(listUsersMock).toHaveBeenCalledWith("office-a");
    const ids = (body as any).users.map((u: any) => u.id);
    expect(ids).toContain("grant-rep");
    expect(ids).toEqual(["rep-1", "grant-rep"]);
  });

  it("still drops inactive and non-CRM (field_contractor) candidates", async () => {
    listUsersMock.mockResolvedValue([
      { id: "rep-1", displayName: "Primary Rep", email: "primary@example.com", role: "rep", officeId: "office-a", isActive: true },
      { id: "grant-rep", displayName: "Grant Rep", email: "grant@example.com", role: "rep", officeId: "office-b", isActive: true },
      { id: "field-1", displayName: "Field", email: "field@example.com", role: "field_contractor", officeId: "office-a", isActive: true },
      { id: "inactive-1", displayName: "Inactive", email: "inactive@example.com", role: "rep", officeId: "office-a", isActive: false },
    ]);

    const { body } = await invokeSalesReps();

    const ids = (body as any).users.map((u: any) => u.id);
    expect(ids).toEqual(["rep-1", "grant-rep"]);
    expect(ids).not.toContain("field-1");
    expect(ids).not.toContain("inactive-1");
  });
});
