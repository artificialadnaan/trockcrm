// Route-surface proof for the marketing expense request mount.
//
// A real Express app with `authMiddleware` and `tenantMiddleware` stubbed, rather than a source-text
// assertion, because the two things worth proving are ROUTING facts: that the mount actually sits behind
// `requireCrmUser`, and that `/mine` is declared before `/:id` so it does not get swallowed as a request id.
// Neither is visible in the text of the files that declare them.
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const currentUser = {
  id: "user-1",
  email: "rep@example.com",
  displayName: "Reggie Rep",
  role: "rep",
  officeId: "office-1",
  activeOfficeId: "office-1",
};

vi.mock("../../../src/middleware/auth.js", () => ({
  authMiddleware: (req: any, _res: any, next: (err?: unknown) => void) => {
    req.user = { ...currentUser };
    next();
  },
}));

vi.mock("../../../src/middleware/tenant.js", () => ({
  tenantMiddleware: (req: any, _res: any, next: (err?: unknown) => void) => {
    req.tenantDb = {};
    req.officeSlug = "dallas";
    req.commitTransaction = async () => undefined;
    next();
  },
}));

const service = {
  createMarketingExpenseRequest: vi.fn(async () => ({ id: "req-1" })),
  submitMarketingExpenseRequest: vi.fn(async () => ({ id: "req-1" })),
  decideMarketingExpenseRequest: vi.fn(async () => ({ id: "req-1" })),
  withdrawMarketingExpenseRequest: vi.fn(async () => ({ id: "req-1" })),
  getMarketingExpenseRequest: vi.fn(async () => ({ id: "req-1" })),
  listMyMarketingExpenseRequests: vi.fn(async () => []),
  listMarketingExpenseQueue: vi.fn(async () => []),
  isApprover: (user: { role: string }) => user.role === "admin" || user.role === "director",
};

vi.mock("../../../src/modules/marketing-expense/service.js", () => service);

const { createApp } = await import("../../../src/app.js");

beforeEach(() => {
  currentUser.role = "rep";
  for (const value of Object.values(service)) {
    if (typeof value === "function" && "mockClear" in value) value.mockClear();
  }
});

describe("marketing expense request route surface", () => {
  it("is CRM-only — a field contractor is refused before any handler runs", async () => {
    currentUser.role = "field_contractor";
    const response = await request(createApp()).get("/api/marketing-expense-requests/mine");
    expect(response.status).toBe(403);
    expect(response.body).toEqual({ error: { message: "CRM access required" } });
  });

  it("routes /mine to the own-rows handler, NOT to the :id handler", async () => {
    const response = await request(createApp()).get("/api/marketing-expense-requests/mine");
    expect(response.status).toBe(200);
    expect(service.listMyMarketingExpenseRequests).toHaveBeenCalledTimes(1);
    expect(service.getMarketingExpenseRequest).not.toHaveBeenCalled();
  });

  it("scopes /mine to the SESSION user, never to a caller-supplied id", async () => {
    await request(createApp()).get("/api/marketing-expense-requests/mine?userId=somebody-else");
    expect(service.listMyMarketingExpenseRequests).toHaveBeenCalledWith(expect.anything(), "user-1");
  });

  it("lets any CRM user create a request", async () => {
    const response = await request(createApp())
      .post("/api/marketing-expense-requests")
      .send({ requestedByName: "Reggie Rep", vendorEvent: "Expo", purpose: "x", expectedReturn: "y" });
    expect(response.status).toBe(201);
    expect(service.createMarketingExpenseRequest).toHaveBeenCalledTimes(1);
  });

  it("attributes the create to the SESSION user, so a posted submittedBy is ignored", async () => {
    await request(createApp())
      .post("/api/marketing-expense-requests")
      .send({ submittedBy: "somebody-else", vendorEvent: "Expo" });
    expect(service.createMarketingExpenseRequest).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ userId: "user-1" }),
    );
  });

  it("refuses a rep the approver queue", async () => {
    const response = await request(createApp()).get("/api/marketing-expense-requests");
    expect(response.status).toBe(403);
    expect(service.listMarketingExpenseQueue).not.toHaveBeenCalled();
  });

  it("refuses a rep the decide endpoint", async () => {
    const response = await request(createApp())
      .post("/api/marketing-expense-requests/req-1/decide")
      .send({ decision: "approved" });
    expect(response.status).toBe(403);
    expect(service.decideMarketingExpenseRequest).not.toHaveBeenCalled();
  });

  it("admits a director to the queue", async () => {
    currentUser.role = "director";
    const response = await request(createApp()).get("/api/marketing-expense-requests");
    expect(response.status).toBe(200);
    expect(service.listMarketingExpenseQueue).toHaveBeenCalledWith(expect.anything(), "pending");
  });

  it("admits an admin to the queue", async () => {
    currentUser.role = "admin";
    const response = await request(createApp()).get("/api/marketing-expense-requests?status=denied");
    expect(response.status).toBe(200);
    expect(service.listMarketingExpenseQueue).toHaveBeenCalledWith(expect.anything(), "denied");
  });

  it("refuses an unknown queue status rather than passing it through to SQL", async () => {
    currentUser.role = "admin";
    const response = await request(createApp()).get("/api/marketing-expense-requests?status=draft");
    expect(response.status).toBe(400);
    expect(service.listMarketingExpenseQueue).not.toHaveBeenCalled();
  });

  it("rejects a decision that is neither approved nor denied", async () => {
    currentUser.role = "director";
    const response = await request(createApp())
      .post("/api/marketing-expense-requests/req-1/decide")
      .send({ decision: "skipped" });
    expect(response.status).toBe(400);
    expect(service.decideMarketingExpenseRequest).not.toHaveBeenCalled();
  });

  it("passes the decision through with the session user as the decider", async () => {
    currentUser.role = "director";
    await request(createApp())
      .post("/api/marketing-expense-requests/req-1/decide")
      .send({ decision: "denied", reason: "Over budget", userId: "somebody-else" });
    expect(service.decideMarketingExpenseRequest).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ requestId: "req-1", userId: "user-1", decision: "denied", reason: "Over budget" }),
    );
  });

  it("lets the submitter submit and withdraw their own request", async () => {
    expect((await request(createApp()).post("/api/marketing-expense-requests/req-1/submit")).status).toBe(200);
    expect((await request(createApp()).post("/api/marketing-expense-requests/req-1/withdraw")).status).toBe(200);
    expect(service.submitMarketingExpenseRequest).toHaveBeenCalledTimes(1);
    expect(service.withdrawMarketingExpenseRequest).toHaveBeenCalledTimes(1);
  });

  it("hands :id reads to the service, which owns the submitter-or-approver check", async () => {
    const response = await request(createApp()).get("/api/marketing-expense-requests/req-1");
    expect(response.status).toBe(200);
    expect(service.getMarketingExpenseRequest).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ requestId: "req-1", user: expect.objectContaining({ id: "user-1", role: "rep" }) }),
    );
  });
});
