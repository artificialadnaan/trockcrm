import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authMiddleware: vi.fn((req: any, _res: any, next: any) => {
    req.user = {
      id: "admin-1",
      email: "admin@trock.dev",
      displayName: "Admin User",
      role: "admin",
      officeId: "office-1",
      activeOfficeId: "office-1",
    };
    next();
  }),
  requireAdmin: vi.fn((_req: any, _res: any, next: any) => next()),
  requireDirector: vi.fn((_req: any, _res: any, next: any) => next()),
  runOwnershipSync: vi.fn(),
  getAccessibleOffices: vi.fn(),
  getMyCleanupQueue: vi.fn(),
  getOfficeOwnershipQueue: vi.fn(),
  bulkReassignOwnershipQueueRows: vi.fn(),
  poolQuery: vi.fn(),
  poolConnect: vi.fn(),
  drizzle: vi.fn(),
  tenantDb: {
    execute: vi.fn(),
  },
  tenantClient: {
    query: vi.fn(),
    release: vi.fn(),
  },
}));

vi.mock("../../../../server/src/middleware/auth.js", () => ({
  authMiddleware: mocks.authMiddleware,
}));

vi.mock("../../../../server/src/middleware/rbac.js", () => ({
  requireAdmin: mocks.requireAdmin,
  requireDirector: mocks.requireDirector,
}));

vi.mock("../../../../server/src/modules/auth/service.js", () => ({
  getAccessibleOffices: mocks.getAccessibleOffices,
}));

vi.mock("../../../../server/src/db.js", () => ({
  pool: {
    query: mocks.poolQuery,
    connect: mocks.poolConnect,
  },
}));

vi.mock("drizzle-orm/node-postgres", () => ({
  drizzle: mocks.drizzle,
}));

vi.mock("../../../../server/src/modules/admin/offices-service.js", () => ({
  listOffices: vi.fn(),
  getOfficeById: vi.fn(),
  createOffice: vi.fn(),
  updateOffice: vi.fn(),
}));

vi.mock("../../../../server/src/modules/admin/users-service.js", () => ({
  getUsersWithStats: vi.fn(),
  getUserById: vi.fn(),
  updateUser: vi.fn(),
  grantOfficeAccess: vi.fn(),
  revokeOfficeAccess: vi.fn(),
}));

vi.mock("../../../../server/src/modules/admin/ownership-sync-service.js", () => ({
  runOwnershipSync: mocks.runOwnershipSync,
}));

vi.mock("../../../../server/src/modules/admin/cleanup-queue-service.js", () => ({
  getMyCleanupQueue: mocks.getMyCleanupQueue,
  getOfficeOwnershipQueue: mocks.getOfficeOwnershipQueue,
  bulkReassignOwnershipQueueRows: mocks.bulkReassignOwnershipQueueRows,
}));

vi.mock("../../../../server/src/modules/admin/pipeline-service.js", () => ({
  listPipelineStages: vi.fn(),
  updatePipelineStage: vi.fn(),
  reorderPipelineStages: vi.fn(),
}));

vi.mock("../../../../server/src/modules/admin/audit-service.js", () => ({
  getAuditLog: vi.fn(),
  getAuditLogEntityTypes: vi.fn(),
}));

import { adminRoutes } from "../../../../server/src/modules/admin/routes.js";

describe("admin ownership sync routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.poolConnect.mockResolvedValue(mocks.tenantClient);
    mocks.drizzle.mockReturnValue(mocks.tenantDb);
    mocks.tenantClient.query.mockResolvedValue({ rows: [] });
  });

  function buildApp() {
    const app = express();
    app.use(express.json());
    app.use("/api", adminRoutes);
    return app;
  }

  function mockTenantContext() {
    mocks.tenantClient.query.mockImplementation(async (query: string) => {
      if (query.includes("SELECT slug FROM public.offices")) {
        return { rows: [{ slug: "dallas" }] };
      }
      if (query.includes("information_schema.schemata")) {
        return { rows: [{ schema_name: "office_dallas" }] };
      }
      return { rows: [] };
    });
  }

  it("wires /admin/ownership-sync/dry-run through the router and passes dryRun=true", async () => {
    mocks.runOwnershipSync.mockResolvedValue({
      assigned: 0,
      unchanged: 0,
      unmatched: 0,
      conflicts: 0,
      inactiveUserConflicts: 0,
      examples: { matched: [], unmatched: [], conflicts: [], inactiveUserConflicts: [] },
    });

    const response = await request(buildApp()).post("/api/admin/ownership-sync/dry-run");

    expect(response.status).toBe(200);
    expect(mocks.authMiddleware).toHaveBeenCalledOnce();
    expect(mocks.requireAdmin).toHaveBeenCalledOnce();
    expect(mocks.runOwnershipSync).toHaveBeenCalledWith({ dryRun: true });
  });

  it("wires /admin/ownership-sync/apply through the router and passes dryRun=false", async () => {
    mocks.runOwnershipSync.mockResolvedValue({
      assigned: 1,
      unchanged: 0,
      unmatched: 0,
      conflicts: 0,
      inactiveUserConflicts: 0,
      examples: { matched: [], unmatched: [], conflicts: [], inactiveUserConflicts: [] },
    });

    const response = await request(buildApp()).post("/api/admin/ownership-sync/apply");

    expect(response.status).toBe(200);
    expect(mocks.authMiddleware).toHaveBeenCalledOnce();
    expect(mocks.requireAdmin).toHaveBeenCalledOnce();
    expect(mocks.runOwnershipSync).toHaveBeenCalledWith({ dryRun: false });
  });

  it("requires admin for /admin/lead-dd-debug", async () => {
    mocks.requireAdmin.mockImplementationOnce((_req: any, res: any) =>
      res.status(403).json({ error: "Forbidden" })
    );

    const response = await request(buildApp()).get(
      "/api/admin/lead-dd-debug?leadId=11111111-1111-4111-8111-111111111111"
    );

    expect(response.status).toBe(403);
    expect(mocks.poolConnect).not.toHaveBeenCalled();
  });

  it("returns 400 when leadId is missing for /admin/lead-dd-debug", async () => {
    const response = await request(buildApp()).get("/api/admin/lead-dd-debug");

    expect(response.status).toBe(400);
    expect(response.body).toEqual({ error: "leadId required" });
  });

  it("returns 400 when leadId is malformed for /admin/lead-dd-debug", async () => {
    const response = await request(buildApp()).get("/api/admin/lead-dd-debug?leadId=not-a-uuid");

    expect(response.status).toBe(400);
    expect(response.body).toEqual({ error: "invalid leadId format" });
  });

  it("returns 404 when leadId is valid but no tenant lead exists", async () => {
    mockTenantContext();
    mocks.tenantDb.execute.mockResolvedValueOnce({ rows: [] });

    const response = await request(buildApp()).get(
      "/api/admin/lead-dd-debug?leadId=11111111-1111-4111-8111-111111111111"
    );

    expect(response.status).toBe(404);
    expect(response.body).toEqual({ error: "Lead not found" });
  });

  it("returns lead DD diagnostic data for a tenant-scoped admin request", async () => {
    mockTenantContext();
    mocks.tenantDb.execute
      .mockResolvedValueOnce({
        rows: [
          {
            id: "11111111-1111-4111-8111-111111111111",
            name: "Bluewater Lead",
            stage_slug: "new_lead",
            company_id: "22222222-2222-4222-8222-222222222222",
            primary_contact_id: "33333333-3333-4333-8333-333333333333",
            property_id: "44444444-4444-4444-8444-444444444444",
            verification_status: "pending",
            verification_required_reason: "new_company",
            created_at: "2026-05-05T12:00:00.000Z",
            last_activity_at: null,
          },
        ],
      })
      .mockResolvedValueOnce({
        rows: [
          {
            id: "55555555-5555-4555-8555-555555555555",
            status: "pending",
            requested_at: "2026-05-05T12:01:00.000Z",
            email_sent_at: null,
            email_message_id: null,
            detection_signal: { detail: "No recent activity" },
            decided_at: null,
            decided_by: null,
          },
        ],
      })
      .mockResolvedValueOnce({
        rows: [
          { email: "tyamashita@trockgc.com", is_active: true },
          { email: "adnaan.iqbal@gmail.com", is_active: true },
        ],
      })
      .mockResolvedValueOnce({
        rows: [
          {
            source: "company-lead",
            type: "lead",
            occurred_at: "2026-04-20T12:00:00.000Z",
            detail: "Recent lead activity on company",
            record_id: "66666666-6666-4666-8666-666666666666",
          },
        ],
      })
      .mockResolvedValueOnce({
        rows: [{ id: "lead-2", name: "Older Lead", created_at: "2026-04-20T12:00:00.000Z", stage_slug: "qualified_lead" }],
      })
      .mockResolvedValueOnce({
        rows: [{ id: "deal-1", name: "Recent Deal", created_at: "2026-04-21T12:00:00.000Z" }],
      })
      .mockResolvedValueOnce({
        rows: [{ id: "lead-3", name: "Contact Lead", created_at: "2026-04-22T12:00:00.000Z", stage_slug: "new_lead" }],
      })
      .mockResolvedValueOnce({
        rows: [{ id: "activity-1", occurred_at: "2026-04-23T12:00:00.000Z", subject: "Call" }],
      })
      .mockResolvedValueOnce({
        rows: [{ id: "email-1", sent_at: "2026-04-24T12:00:00.000Z", subject: "Follow up", direction: "outbound" }],
      });

    const response = await request(buildApp()).get(
      "/api/admin/lead-dd-debug?leadId=11111111-1111-4111-8111-111111111111"
    );

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      lead: {
        id: "11111111-1111-4111-8111-111111111111",
        stage_slug: "new_lead",
        verification_status: "pending",
      },
      duediligence: {
        approval_row: {
          id: "55555555-5555-4555-8555-555555555555",
          status: "pending",
        },
        recipients: [
          { email: "tyamashita@trockgc.com", is_active: true },
          { email: "adnaan.iqbal@gmail.com", is_active: true },
        ],
      },
      detection_signals_found: [
        {
          source: "company-lead",
          type: "lead",
          detail: "Recent lead activity on company",
          record_id: "66666666-6666-4666-8666-666666666666",
        },
      ],
      detection_signals_within_12mo: 1,
      recent_activity: {
        leads_on_company: [{ id: "lead-2", stage_slug: "qualified_lead" }],
        deals_on_company: [{ id: "deal-1", name: "Recent Deal" }],
        leads_on_contact: [{ id: "lead-3", stage_slug: "new_lead" }],
        activities_on_company: [{ id: "activity-1", subject: "Call" }],
        emails_on_contact: [{ id: "email-1", direction: "outbound" }],
      },
    });
    expect(mocks.tenantDb.execute).toHaveBeenCalledTimes(9);
    expect(mocks.tenantClient.query).toHaveBeenCalledWith("COMMIT");
  });

  it("routes /admin/cleanup/office through a cross-office selection without a role override", async () => {
    mocks.getAccessibleOffices.mockResolvedValue([
      { id: "office-1", name: "Office One", slug: "office-one" },
      { id: "office-2", name: "Office Two", slug: "office-two" },
    ]);
    mocks.getOfficeOwnershipQueue.mockResolvedValue({
      rows: [{ recordId: "deal-1" }],
      byReason: [],
    });

    const response = await request(buildApp()).get("/api/admin/cleanup/office?officeId=office-2");

    expect(response.status).toBe(200);
    expect(mocks.getAccessibleOffices).toHaveBeenCalledWith("admin-1", "admin", "office-1");
    expect(mocks.getOfficeOwnershipQueue).toHaveBeenCalledOnce();
    expect(mocks.getOfficeOwnershipQueue).toHaveBeenCalledWith(expect.anything(), "office-2", expect.any(Object));
    expect(response.body).toEqual({
      rows: [
        {
          recordId: "deal-1",
          officeName: "Office Two",
          assignedUserName: null,
        },
      ],
      byReason: [],
    });
  });

  it("routes /admin/cleanup/my through tenant auth wiring and returns rows", async () => {
    mocks.tenantClient.query.mockImplementation(async (query: string) => {
      if (query.includes("SELECT slug FROM public.offices")) {
        return { rows: [{ slug: "office-one" }] };
      }
      if (query.includes("information_schema.schemata")) {
        return { rows: [{ schema_name: "office_office-one" }] };
      }
      return { rows: [] };
    });
    mocks.getMyCleanupQueue.mockResolvedValue({
      rows: [
        {
          recordId: "deal-1",
          recordType: "deal",
          recordName: "Queued Deal",
        },
      ],
      byReason: [],
    });

    const response = await request(buildApp()).get("/api/admin/cleanup/my");

    expect(response.status).toBe(200);
    expect(mocks.authMiddleware).toHaveBeenCalledOnce();
    expect(mocks.poolConnect).toHaveBeenCalledOnce();
    expect(mocks.drizzle).toHaveBeenCalledOnce();
    expect(mocks.getMyCleanupQueue).toHaveBeenCalledWith(expect.anything(), "admin-1", "office-1");
    expect(response.body).toEqual({
      rows: [
        {
          recordId: "deal-1",
          recordType: "deal",
          recordName: "Queued Deal",
        },
      ],
    });
  });

  it("routes /admin/cleanup/reassign through a cross-office selection without a role override", async () => {
    mocks.getAccessibleOffices.mockResolvedValue([
      { id: "office-1", name: "Office One", slug: "office-one" },
      { id: "office-2", name: "Office Two", slug: "office-two" },
    ]);
    mocks.bulkReassignOwnershipQueueRows.mockResolvedValue({ updated: 1 });

    const response = await request(buildApp())
      .post("/api/admin/cleanup/reassign")
      .send({
        officeId: "office-2",
        assigneeId: "rep-1",
      rows: [{ recordType: "deal", recordId: "deal-1" }],
    });

    expect(response.status).toBe(200);
    expect(mocks.getAccessibleOffices).toHaveBeenCalledWith("admin-1", "admin", "office-1");
    expect(mocks.bulkReassignOwnershipQueueRows).toHaveBeenCalledOnce();
    expect(mocks.bulkReassignOwnershipQueueRows).toHaveBeenCalledWith(
      expect.anything(),
      expect.any(Object),
      expect.objectContaining({ officeId: "office-2", assigneeId: "rep-1" })
    );
  });
});
