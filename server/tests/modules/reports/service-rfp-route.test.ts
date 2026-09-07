import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ getServiceRfpReport: vi.fn() }));
vi.mock("../../../src/modules/reports/service-rfp-service.js", () => mocks);
import { reportRoutes } from "../../../src/modules/reports/routes.js";

function app(role: string, officeId: string | null = "office-active") {
  const server = express();
  server.use((req, _res, next) => {
    Object.assign(req, { user: { id: "self-rep", role, activeOfficeId: officeId, officeId }, tenantDb: {}, commitTransaction: async () => {} });
    next();
  });
  server.use("/reports", reportRoutes);
  server.use((error: { statusCode?: number; message?: string }, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(error.statusCode ?? 500).json({ error: error.message });
  });
  return server;
}

describe("service RFP report route scope", () => {
  beforeEach(() => { mocks.getServiceRfpReport.mockReset().mockResolvedValue({ total: 0 }); });
  it("forces a rep's own attribution filter and uses the authenticated active office", async () => {
    const response = await request(app("rep")).get("/reports/service-rfps?ownerIds=other&owners=Other&ownerEmails=other@example.com");
    expect(response.status).toBe(200);
    expect(mocks.getServiceRfpReport).toHaveBeenCalledWith({}, expect.objectContaining({ ownerIds: ["self-rep"], ownerNames: [], ownerEmails: [] }), "office-active");
  });
  it("preserves a director's selected attribution filter", async () => {
    expect((await request(app("director")).get("/reports/service-rfps?ownerIds=other")).status).toBe(200);
    expect(mocks.getServiceRfpReport.mock.calls[0]?.[1].ownerIds).toEqual(["other"]);
  });
  it("denies roles outside the reporting audience", async () => {
    expect((await request(app("field_contractor")).get("/reports/service-rfps")).status).toBe(403);
    expect(mocks.getServiceRfpReport).not.toHaveBeenCalled();
  });
  it("refuses absent office context before querying public submission history", async () => {
    expect((await request(app("admin", null)).get("/reports/service-rfps")).status).toBe(400);
    expect(mocks.getServiceRfpReport).not.toHaveBeenCalled();
  });
});
