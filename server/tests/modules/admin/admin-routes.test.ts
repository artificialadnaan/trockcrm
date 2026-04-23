import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authMiddleware: vi.fn((req: any, _res: any, next: any) => {
    req.user = {
      id: "user-1",
      email: "admin@trock.dev",
      displayName: "Admin User",
      role: "admin",
      officeId: "office-1",
      activeOfficeId: "office-1",
    };
    next();
  }),
  requireDirector: vi.fn((_req: any, _res: any, next: any) => next()),
  tenantMiddleware: vi.fn((req: any, _res: any, next: any) => {
    req.tenantDb = {};
    req.commitTransaction = vi.fn().mockResolvedValue(undefined);
    next();
  }),
  previewUserInvite: vi.fn().mockResolvedValue({
    recipientEmail: "rep@example.com",
    loginUrl: "https://frontend-production-bcab.up.railway.app/login",
    subject: "Your T Rock CRM invite",
    html: "<p>Preview</p>",
    text: "Preview",
  }),
  revokeUserInvite: vi.fn().mockResolvedValue(undefined),
  sendUserInvite: vi.fn().mockResolvedValue({ success: true }),
  getUserLocalAuthEvents: vi.fn().mockResolvedValue([
    {
      id: "event-1",
      eventType: "invite_sent",
      actorUserId: "user-1",
      actorDisplayName: "Admin User",
      metadata: null,
      createdAt: "2026-04-20T10:00:00.000Z",
    },
  ]),
}));

vi.mock("../../../src/middleware/auth.js", () => ({
  authMiddleware: mocks.authMiddleware,
}));

vi.mock("../../../src/middleware/rbac.js", () => ({
  requireAdmin: vi.fn((_req: any, _res: any, next: any) => next()),
  requireDirector: mocks.requireDirector,
}));

vi.mock("../../../src/middleware/tenant.js", () => ({
  tenantMiddleware: mocks.tenantMiddleware,
}));

vi.mock("../../../src/modules/admin/admin-reporting-service.js", () => ({
  getAdminDataScrubOverview: vi.fn().mockResolvedValue({
    summary: {
      openDuplicateContacts: 1,
      resolvedDuplicateContacts7d: 1,
      openOwnershipGaps: 2,
      recentScrubActions7d: 3,
    },
    backlogBuckets: [],
    ownershipCoverage: [],
    scrubActivityByUser: [],
  }),
}));

vi.mock("../../../src/modules/admin/users-service.js", () => ({
  getUsersWithStats: vi.fn(),
  getUserById: vi.fn(),
  updateUser: vi.fn(),
  grantOfficeAccess: vi.fn(),
  revokeOfficeAccess: vi.fn(),
  listOffices: vi.fn(),
  getOfficeById: vi.fn(),
  createOffice: vi.fn(),
  updateOffice: vi.fn(),
  listPipelineStages: vi.fn(),
  updatePipelineStage: vi.fn(),
  reorderPipelineStages: vi.fn(),
  getAuditLog: vi.fn(),
  getAuditLogTables: vi.fn(),
  getUserLocalAuthEvents: mocks.getUserLocalAuthEvents,
}));

vi.mock("../../../src/modules/auth/local-auth-service.js", () => ({
  previewUserInvite: mocks.previewUserInvite,
  revokeUserInvite: mocks.revokeUserInvite,
  sendUserInvite: mocks.sendUserInvite,
}));

import { adminRoutes } from "../../../src/modules/admin/routes.js";

describe("admin data scrub routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns the admin data scrub overview on the admin route family", async () => {
    const app = express();
    app.use("/api", adminRoutes);

    const response = await request(app).get("/api/admin/data-scrub/overview");

    expect(response.status).toBe(200);
    expect(response.body.summary).toEqual({
      openDuplicateContacts: 1,
      resolvedDuplicateContacts7d: 1,
      openOwnershipGaps: 2,
      recentScrubActions7d: 3,
    });
    expect(mocks.authMiddleware).toHaveBeenCalledOnce();
    expect(mocks.requireDirector).toHaveBeenCalledOnce();
    expect(mocks.tenantMiddleware).toHaveBeenCalledOnce();
  });

  it("returns an invite preview without sending email", async () => {
    const app = express();
    app.use(express.json());
    app.use("/api", adminRoutes);

    const response = await request(app).post("/api/admin/users/user-22/preview-invite");

    expect(response.status).toBe(200);
    expect(response.body.preview.recipientEmail).toBe("rep@example.com");
    expect(mocks.previewUserInvite).toHaveBeenCalledWith({
      userId: "user-22",
      actorUserId: "user-1",
    });
    expect(mocks.sendUserInvite).not.toHaveBeenCalled();
  });

  it("revokes local-auth access for a user", async () => {
    const app = express();
    app.use(express.json());
    app.use("/api", adminRoutes);

    const response = await request(app).post("/api/admin/users/user-22/revoke-invite");

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ success: true });
    expect(mocks.revokeUserInvite).toHaveBeenCalledWith({
      userId: "user-22",
      actorUserId: "user-1",
    });
  });

  it("returns local-auth history for the admin users page", async () => {
    const app = express();
    app.use("/api", adminRoutes);

    const response = await request(app).get("/api/admin/users/user-22/local-auth-events");

    expect(response.status).toBe(200);
    expect(response.body.events).toHaveLength(1);
    expect(response.body.events[0]?.eventType).toBe("invite_sent");
    expect(mocks.getUserLocalAuthEvents).toHaveBeenCalledWith("user-22");
  });
});
