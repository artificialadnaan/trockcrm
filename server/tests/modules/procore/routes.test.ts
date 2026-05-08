import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const queryMock = vi.fn();
const dbExecuteMock = vi.fn();
const dbSelectRows: any[][] = [];
const dbUpdateRows: any[][] = [];
const procoreGetMock = vi.fn();
const procorePatchMock = vi.fn();

vi.mock("../../../src/middleware/rbac.js", () => ({
  requireRole: () => (_req: express.Request, _res: express.Response, next: express.NextFunction) =>
    next(),
}));

vi.mock("../../../src/db.js", () => ({
  db: {
    execute: dbExecuteMock,
    select: vi.fn(() => {
      const chain: any = {
        from: vi.fn(() => chain),
        where: vi.fn(() => chain),
        orderBy: vi.fn(() => chain),
        limit: vi.fn(() => Promise.resolve(dbSelectRows.shift() ?? [])),
      };
      return chain;
    }),
    update: vi.fn(() => {
      const chain: any = {
        set: vi.fn(() => chain),
        where: vi.fn(() => chain),
        returning: vi.fn(() => Promise.resolve(dbUpdateRows.shift() ?? [])),
      };
      return chain;
    }),
  },
}));

vi.mock("../../../src/lib/procore-client.js", () => ({
  isProcoreOauthRefreshError: vi.fn(() => false),
  isProcoreOauthRequiredError: vi.fn(() => false),
  procoreClient: {
    get: procoreGetMock,
    patch: procorePatchMock,
    getCircuitState: vi.fn(() => ({ state: "closed", failures: 0, openedAt: null })),
  },
}));

const { procoreRoutes } = await import("../../../src/modules/procore/routes.js");
const { errorHandler } = await import("../../../src/middleware/error-handler.js");

function createTestApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).user = {
      id: "rep-1",
      role: "director",
      displayName: "Rep One",
      email: "rep@example.com",
      officeId: "office-1",
      activeOfficeId: "office-1",
    } as any;
    (req as any).tenantClient = {
      query: queryMock,
    } as any;
    (req as any).commitTransaction = vi.fn().mockResolvedValue(undefined);
    next();
  });
  app.use("/api/procore", procoreRoutes);
  app.use(errorHandler);
  return app;
}

function createRepTestApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).user = {
      id: "rep-1",
      role: "rep",
      displayName: "Rep One",
      email: "rep@example.com",
      officeId: "office-1",
      activeOfficeId: "office-1",
    } as any;
    (req as any).tenantClient = {
      query: queryMock,
    } as any;
    (req as any).commitTransaction = vi.fn().mockResolvedValue(undefined);
    next();
  });
  app.use("/api/procore", procoreRoutes);
  app.use(errorHandler);
  return app;
}

describe("procore routes", () => {
  const dealId = "11111111-1111-4111-8111-111111111111";
  const otherDealId = "22222222-2222-4222-8222-222222222222";

  beforeEach(() => {
    vi.clearAllMocks();
    dbSelectRows.length = 0;
    dbUpdateRows.length = 0;
    process.env.PROCORE_COMPANY_ID = "company-123";
  });

  afterEach(() => {
    delete process.env.PROCORE_COMPANY_ID;
  });

  it("returns a single project for the project detail route", async () => {
    queryMock.mockResolvedValueOnce({
      rows: [
        {
          id: dealId,
          deal_number: "TR-1001",
          name: "Birchstone North Tower",
          procore_project_id: 999,
          procore_last_synced_at: "2026-04-19T10:00:00.000Z",
          change_order_total: "12500",
          stage_name: "In Production",
          stage_color: "#0f766e",
        },
      ],
    });

    const response = await request(createTestApp()).get(`/api/procore/my-projects/${dealId}`);

    expect(response.status).toBe(200);
    expect(response.body.project.name).toBe("Birchstone North Tower");
    expect(response.headers["cross-origin-resource-policy"]).toBe("cross-origin");
    expect(queryMock).toHaveBeenCalledWith(
      expect.stringContaining("WHERE d.procore_project_id IS NOT NULL"),
      [dealId],
    );
  });

  it("marks the project list route as cross-origin consumable for the Railway frontend", async () => {
    queryMock.mockResolvedValueOnce({ rows: [] });

    const response = await request(createRepTestApp()).get("/api/procore/my-projects");

    expect(response.status).toBe(200);
    expect(response.headers["cross-origin-resource-policy"]).toBe("cross-origin");
  });

  it("returns 404 when the project is missing", async () => {
    queryMock.mockResolvedValueOnce({ rows: [] });

    const response = await request(createTestApp()).get(`/api/procore/my-projects/${dealId}`);

    expect(response.status).toBe(404);
  });

  it("returns 404 before querying when the project id is not a uuid", async () => {
    const response = await request(createTestApp()).get("/api/procore/my-projects/not-a-uuid");

    expect(response.status).toBe(404);
    expect(response.body).toEqual({ error: { message: "Project not found", code: undefined } });
    expect(queryMock).not.toHaveBeenCalled();
  });

  it("allows a rep to fetch only their own project-backed deal", async () => {
    queryMock
      .mockResolvedValueOnce({
        rows: [
          {
            id: dealId,
            deal_number: "TR-1001",
            name: "Birchstone North Tower",
            procore_project_id: 999,
            procore_last_synced_at: "2026-04-19T10:00:00.000Z",
            change_order_total: "12500",
            stage_name: "In Production",
            stage_color: "#0f766e",
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [] });

    const app = createRepTestApp();
    const ownResponse = await request(app).get(`/api/procore/my-projects/${dealId}`);
    const unrelatedResponse = await request(app).get(`/api/procore/my-projects/${otherDealId}`);

    expect(ownResponse.status).toBe(200);
    expect(ownResponse.body.project.id).toBe(dealId);
    expect(unrelatedResponse.status).toBe(404);
    expect(queryMock).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining("AND d.assigned_rep_id = $2"),
      [dealId, "rep-1"],
    );
    expect(queryMock).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining("AND d.assigned_rep_id = $2"),
      [otherDealId, "rep-1"],
    );
  });

  it("resolves accept_crm conflicts by recording intent, checking Procore idempotently, patching, then marking synced", async () => {
    dbSelectRows.push([
      {
        id: "sync-1",
        officeId: "office-1",
        syncStatus: "conflict",
        crmEntityType: "deal",
        crmEntityId: dealId,
        procoreId: 999,
        conflictData: { procore_status: "Bidding" },
      },
    ]);
    dbUpdateRows.push(
      [{ id: "sync-1", syncStatus: "pending" }],
      [{ id: "sync-1", syncStatus: "synced" }],
    );
    queryMock.mockResolvedValueOnce({
      rows: [{ id: dealId, name: "Deal", procore_stage_mapping: "Awarded" }],
    });
    procoreGetMock.mockResolvedValueOnce({ stage: "Bidding" });
    procorePatchMock.mockResolvedValueOnce({ id: 999, stage: "Awarded" });

    const response = await request(createTestApp())
      .post("/api/procore/sync-conflicts/sync-1/resolve")
      .send({ resolution: "accept_crm" });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ success: true, status: "synced" });
    expect(response.body.resolutionId).toMatch(/^res_/);
    expect(procoreGetMock).toHaveBeenCalledWith("/rest/v1.0/companies/company-123/projects/999");
    expect(procorePatchMock).toHaveBeenCalledWith(
      "/rest/v1.0/companies/company-123/projects/999",
      { project: { stage: "Awarded" } },
    );
  });

  it("skips accept_crm PATCH when Procore is already at the target stage", async () => {
    dbSelectRows.push([
      {
        id: "sync-1",
        officeId: "office-1",
        syncStatus: "conflict",
        crmEntityType: "deal",
        crmEntityId: dealId,
        procoreId: 999,
        conflictData: { procore_status: "Awarded" },
      },
    ]);
    dbUpdateRows.push(
      [{ id: "sync-1", syncStatus: "pending" }],
      [{ id: "sync-1", syncStatus: "synced" }],
    );
    queryMock.mockResolvedValueOnce({
      rows: [{ id: dealId, name: "Deal", procore_stage_mapping: "Awarded" }],
    });
    procoreGetMock.mockResolvedValueOnce({ stage: "Awarded" });

    const response = await request(createTestApp())
      .post("/api/procore/sync-conflicts/sync-1/resolve")
      .send({ resolution: "accept_crm" });

    expect(response.status).toBe(200);
    expect(response.body.status).toBe("synced");
    expect(procorePatchMock).not.toHaveBeenCalled();
  });

  it("stores a sanitized correlation message when Phase B fails", async () => {
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    dbSelectRows.push([
      {
        id: "sync-1",
        officeId: "office-1",
        syncStatus: "conflict",
        crmEntityType: "deal",
        crmEntityId: dealId,
        procoreId: 999,
        conflictData: { procore_status: "Bidding" },
      },
    ]);
    dbUpdateRows.push([{ id: "sync-1", syncStatus: "pending" }]);
    queryMock.mockResolvedValueOnce({
      rows: [{ id: dealId, name: "Deal", procore_stage_mapping: "Awarded" }],
    });
    procoreGetMock.mockRejectedValueOnce(new Error("Procore response body: SELECT secret stack"));

    const response = await request(createTestApp())
      .post("/api/procore/sync-conflicts/sync-1/resolve")
      .send({ resolution: "accept_crm" });

    expect(response.status).toBe(500);
    const updateCalls = (await import("../../../src/db.js")).db.update as any;
    expect(updateCalls).toHaveBeenCalled();
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringMatching(/\[Procore conflict resolution err_/),
      expect.objectContaining({ errorStack: expect.any(String) }),
    );
    consoleErrorSpy.mockRestore();
  });
});
