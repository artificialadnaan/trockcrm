import { beforeEach, describe, expect, it, vi } from "vitest";

const apiMock = vi.hoisted(() => vi.fn());
class ApiError extends Error {
  status: number;
  code?: string;
  constructor(status: number, code?: string, message?: string) {
    super(message ?? `HTTP ${status}`);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }
}
vi.mock("@/lib/api", () => ({
  api: apiMock,
  isApiError: (e: unknown) => e instanceof ApiError,
}));

const {
  listFieldResponders,
  createFieldResponder,
  updateFieldResponder,
  getFieldResponderAssignments,
  isFieldResponderEmailDuplicate,
  FIELD_RESPONDER_EMAIL_DUPLICATE,
} = await import("./use-field-responders");

describe("field-responder client API", () => {
  beforeEach(() => {
    apiMock.mockReset();
  });

  it("listFieldResponders hits the roster route with no query when active-only", async () => {
    apiMock.mockResolvedValue({ responders: [] });
    const rows = await listFieldResponders();
    expect(apiMock).toHaveBeenCalledWith("/field-responders");
    expect(rows).toEqual([]);
  });

  it("listFieldResponders appends ?includeInactive=true when requested", async () => {
    apiMock.mockResolvedValue({ responders: [{ id: "r-1" }] });
    const rows = await listFieldResponders({ includeInactive: true });
    expect(apiMock).toHaveBeenCalledWith("/field-responders?includeInactive=true");
    expect(rows).toEqual([{ id: "r-1" }]);
  });

  it("createFieldResponder POSTs name/email/role and unwraps the responder", async () => {
    apiMock.mockResolvedValue({ responder: { id: "r-9", name: "Ext" } });
    const created = await createFieldResponder({
      name: "Ext Super",
      email: "ext@example.com",
      role: "superintendent",
    });
    expect(apiMock).toHaveBeenCalledWith("/field-responders", {
      method: "POST",
      json: { name: "Ext Super", email: "ext@example.com", role: "superintendent" },
    });
    expect(created).toEqual({ id: "r-9", name: "Ext" });
  });

  it("updateFieldResponder PATCHes the given subset", async () => {
    apiMock.mockResolvedValue({ responder: { id: "r-3" } });
    await updateFieldResponder("r-3", { isActive: false });
    expect(apiMock).toHaveBeenCalledWith("/field-responders/r-3", {
      method: "PATCH",
      json: { isActive: false },
    });
  });

  it("getFieldResponderAssignments hits the :id/assignments route and unwraps deals", async () => {
    apiMock.mockResolvedValue({ deals: [{ dealId: "d-1", dealName: "Job A", role: "project_manager" }] });
    const deals = await getFieldResponderAssignments("r-1");
    expect(apiMock).toHaveBeenCalledWith("/field-responders/r-1/assignments");
    expect(deals).toEqual([{ dealId: "d-1", dealName: "Job A", role: "project_manager" }]);
  });

  it("isFieldResponderEmailDuplicate is true only for the 409 duplicate-email code", () => {
    expect(isFieldResponderEmailDuplicate(new ApiError(409, FIELD_RESPONDER_EMAIL_DUPLICATE))).toBe(true);
    // Wrong status
    expect(isFieldResponderEmailDuplicate(new ApiError(400, FIELD_RESPONDER_EMAIL_DUPLICATE))).toBe(false);
    // Wrong / missing code
    expect(isFieldResponderEmailDuplicate(new ApiError(409, "SOMETHING_ELSE"))).toBe(false);
    expect(isFieldResponderEmailDuplicate(new ApiError(409))).toBe(false);
    // Not an ApiError at all
    expect(isFieldResponderEmailDuplicate(new Error("boom"))).toBe(false);
  });
});
