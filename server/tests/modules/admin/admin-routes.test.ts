import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppError } from "../../../src/middleware/error-handler.js";

const mocks = vi.hoisted(() => ({
  userRole: "admin",
  authDisabled: false,
  authMiddleware: vi.fn((req: any, _res: any, next: any) => {
    if (mocks.authDisabled) {
      next();
      return;
    }
    req.user = {
      id: "user-1",
      email: "admin@trock.dev",
      displayName: "Admin User",
      role: mocks.userRole,
      officeId: "office-1",
      activeOfficeId: "office-1",
    };
    next();
  }),
  requireDirector: vi.fn((req: any, res: any, next: any) => {
    if (req.user?.role === "admin" || req.user?.role === "director") {
      next();
      return;
    }
    res.status(403).json({ error: { message: "Director access required" } });
  }),
  requireAdmin: vi.fn((req: any, res: any, next: any) => {
    if (req.user?.role === "admin") {
      next();
      return;
    }
    res.status(403).json({ error: { message: "Admin access required" } });
  }),
  requireGlobalAdmin: vi.fn((req: any, res: any, next: any) => {
    if ((req.user?.baseRole ?? req.user?.role) === "admin") {
      next();
      return;
    }
    res.status(403).json({ error: { message: "Global admin required" } });
  }),
  tenantMiddleware: vi.fn((req: any, _res: any, next: any) => {
    req.tenantDb = {};
    req.tenantClient = mocks.tenantClient;
    req.commitTransaction = mocks.commitTransaction;
    next();
  }),
  decideLeadDueDiligenceApproval: vi.fn(),
  getNotificationRecipientGroup: vi.fn(),
  listLeadDueDiligenceApprovals: vi.fn(),
  updateNotificationRecipientAssignments: vi.fn(),
  previewUserInvite: vi.fn().mockResolvedValue({
    recipientEmail: "rep@example.com",
    loginUrl: "https://frontend-production-bcab.up.railway.app/login",
    subject: "Your T Rock CRM invite",
    html: "<p>Preview</p>",
    text: "Preview",
  }),
  revokeUserInvite: vi.fn().mockResolvedValue(undefined),
  sendUserInvite: vi.fn().mockResolvedValue({ success: true }),
  tenantClient: { query: vi.fn() },
  getAdminPhotoAuditEvents: vi.fn(),
  logPhotoEvent: vi.fn().mockResolvedValue(undefined),
  commitTransaction: vi.fn().mockResolvedValue(undefined),
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
  requireAdmin: mocks.requireAdmin,
  requireDirector: mocks.requireDirector,
  requireGlobalAdmin: mocks.requireGlobalAdmin,
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
  getAuditLogEntityTypes: vi.fn(),
  getUserLocalAuthEvents: mocks.getUserLocalAuthEvents,
}));

vi.mock("../../../src/modules/auth/local-auth-service.js", () => ({
  previewUserInvite: mocks.previewUserInvite,
  revokeUserInvite: mocks.revokeUserInvite,
  sendUserInvite: mocks.sendUserInvite,
}));


vi.mock("../../../src/modules/files/audit-log-service.js", () => ({
  getAdminPhotoAuditEvents: mocks.getAdminPhotoAuditEvents,
  logPhotoEvent: mocks.logPhotoEvent,
  parseCsvQueryParam: (value: unknown) => {
    const values = Array.isArray(value) ? value : value === undefined ? [] : [value];
    return values
      .flatMap((entry) => String(entry).split(","))
      .map((entry) => entry.trim())
      .filter(Boolean);
  },
  parsePhotoAuditEventTypes: (value: unknown) => {
    const allowed = new Set([
      "uploaded",
      "category_changed",
      "address_changed",
      "caption_changed",
      "downloaded",
      "deleted",
      "restored",
      "procore_synced",
      "procore_sync_failed",
      "procore_sync_retry_requested",
    ]);
    const values = Array.isArray(value) ? value : value === undefined ? [] : [value];
    return values
      .flatMap((entry) => String(entry).split(","))
      .map((entry) => entry.trim())
      .filter((entry) => allowed.has(entry));
  },
}));

vi.mock("../../../src/modules/leads/due-diligence-service.js", () => ({
  decideLeadDueDiligenceApproval: mocks.decideLeadDueDiligenceApproval,
  getNotificationRecipientGroup: mocks.getNotificationRecipientGroup,
  listLeadDueDiligenceApprovals: mocks.listLeadDueDiligenceApprovals,
  updateNotificationRecipientAssignments: mocks.updateNotificationRecipientAssignments,
}));

import { adminRoutes } from "../../../src/modules/admin/routes.js";

function createAdminApp() {
  const app = express();
  app.use(express.json());
  app.use("/api", adminRoutes);
  app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    if (err instanceof AppError) {
      res.status(err.statusCode).json({ error: { message: err.message, code: err.code } });
      return;
    }
    res.status(500).json({ error: { message: "Internal server error" } });
  });
  return app;
}

const pendingApproval = {
  id: "approval-1",
  lead_id: "lead-1",
  status: "pending",
  requested_at: "2026-05-01T12:00:00.000Z",
  decided_at: null,
  decision_reason: null,
  detection_signal: { source: "company", type: "lead", detail: "No recent activity found", occurred_at: null },
  email_sent_at: null,
  email_message_id: null,
  lead_name: "New Lead",
  company_name: "Acme HOA",
  company_verification_status: "pending",
  primary_contact_name: "Taylor Contact",
  primary_contact_email: "taylor@example.com",
  primary_contact_role: "property_manager",
  primary_contact_role_other_label: null,
  property_address: "123 Main St",
  property_city: "Dallas",
  property_state: "TX",
  property_zip: "75201",
  unit_count: 120,
  build_year: 1998,
  project_type_name: "Exterior Renovation",
  budget_status: "budgeted_q1",
  bid_due_date: "2026-06-01",
  requested_by_name: "Admin User",
  decided_by_name: null,
};

const recipientGroupResult = {
  group: {
    id: "group-1",
    key: "lead_due_diligence",
    name: "Lead Due Diligence",
    description: "Recipients who receive new-customer lead due diligence approval requests.",
  },
  recipients: [
    { userId: "director-1", displayName: "Director User", email: "director@trock.dev" },
  ],
};

describe("admin data scrub routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.userRole = "admin";
    mocks.authDisabled = false;
    mocks.tenantClient.query.mockReset();
    mocks.commitTransaction.mockResolvedValue(undefined);
    mocks.getAdminPhotoAuditEvents.mockResolvedValue({ events: [], total: 0, page: 1, perPage: 50 });
    mocks.logPhotoEvent.mockResolvedValue(undefined);
    mocks.listLeadDueDiligenceApprovals.mockResolvedValue([pendingApproval]);
    mocks.decideLeadDueDiligenceApproval.mockResolvedValue({
      id: "approval-1",
      status: "approved",
      decidedBy: "user-1",
    });
    mocks.getNotificationRecipientGroup.mockResolvedValue(recipientGroupResult);
    mocks.updateNotificationRecipientAssignments.mockResolvedValue(recipientGroupResult);
  });

  it("returns the admin data scrub overview on the admin route family", async () => {
    const app = createAdminApp();

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
    const app = createAdminApp();

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
    const app = createAdminApp();

    const response = await request(app).post("/api/admin/users/user-22/revoke-invite");

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ success: true });
    expect(mocks.revokeUserInvite).toHaveBeenCalledWith({
      userId: "user-22",
      actorUserId: "user-1",
    });
  });

  it("returns local-auth history for the admin users page", async () => {
    const app = createAdminApp();

    const response = await request(app).get("/api/admin/users/user-22/local-auth-events");

    expect(response.status).toBe(200);
    expect(response.body.events).toHaveLength(1);
    expect(response.body.events[0]?.eventType).toBe("invite_sent");
    expect(mocks.getUserLocalAuthEvents).toHaveBeenCalledWith("user-22");
  });

  it("returns pending Due Diligence approvals with full lead summary", async () => {
    const app = createAdminApp();

    const response = await request(app).get("/api/admin/lead-due-diligence-approvals?status=pending");

    expect(response.status).toBe(200);
    expect(mocks.listLeadDueDiligenceApprovals).toHaveBeenCalledWith(expect.anything(), "pending");
    expect(response.body.approvals[0]).toMatchObject({
      id: "approval-1",
      status: "pending",
      lead_name: "New Lead",
      company_name: "Acme HOA",
      primary_contact_name: "Taylor Contact",
      property_address: "123 Main St",
      requested_by_name: "Admin User",
    });
  });

  it("filters Due Diligence approvals by approved status", async () => {
    mocks.listLeadDueDiligenceApprovals.mockResolvedValueOnce([{ ...pendingApproval, status: "approved" }]);
    const app = createAdminApp();

    const response = await request(app).get("/api/admin/lead-due-diligence-approvals?status=approved");

    expect(response.status).toBe(200);
    expect(mocks.listLeadDueDiligenceApprovals).toHaveBeenCalledWith(expect.anything(), "approved");
    expect(response.body.approvals).toEqual([expect.objectContaining({ status: "approved" })]);
  });

  it("filters Due Diligence approvals by rejected status", async () => {
    mocks.listLeadDueDiligenceApprovals.mockResolvedValueOnce([{ ...pendingApproval, status: "rejected" }]);
    const app = createAdminApp();

    const response = await request(app).get("/api/admin/lead-due-diligence-approvals?status=rejected");

    expect(response.status).toBe(200);
    expect(mocks.listLeadDueDiligenceApprovals).toHaveBeenCalledWith(expect.anything(), "rejected");
    expect(response.body.approvals).toEqual([expect.objectContaining({ status: "rejected" })]);
  });

  it("defaults Due Diligence approval list to pending", async () => {
    const app = createAdminApp();

    const response = await request(app).get("/api/admin/lead-due-diligence-approvals");

    expect(response.status).toBe(200);
    expect(mocks.listLeadDueDiligenceApprovals).toHaveBeenCalledWith(expect.anything(), "pending");
  });

  it("requires director access to list Due Diligence approvals", async () => {
    mocks.userRole = "rep";
    const app = createAdminApp();

    const response = await request(app).get("/api/admin/lead-due-diligence-approvals");

    expect(response.status).toBe(403);
    expect(mocks.listLeadDueDiligenceApprovals).not.toHaveBeenCalled();
  });

  it("approves a pending Due Diligence approval through the decision service", async () => {
    const app = createAdminApp();

    const response = await request(app).post("/api/admin/lead-due-diligence-approvals/approval-1/approve");

    expect(response.status).toBe(200);
    expect(mocks.decideLeadDueDiligenceApproval).toHaveBeenCalledWith(expect.anything(), {
      approvalId: "approval-1",
      decision: "approve",
      userId: "user-1",
    });
    expect(response.body.approval).toMatchObject({ status: "approved" });
  });

  it("rejects a pending Due Diligence approval with a valid reason", async () => {
    mocks.decideLeadDueDiligenceApproval.mockResolvedValueOnce({
      id: "approval-1",
      status: "rejected",
      decisionReason: "The company is not eligible.",
    });
    const app = createAdminApp();

    const response = await request(app)
      .post("/api/admin/lead-due-diligence-approvals/approval-1/reject")
      .send({ reason: "The company is not eligible." });

    expect(response.status).toBe(200);
    expect(mocks.decideLeadDueDiligenceApproval).toHaveBeenCalledWith(expect.anything(), {
      approvalId: "approval-1",
      decision: "reject",
      reason: "The company is not eligible.",
      userId: "user-1",
    });
    expect(response.body.approval).toMatchObject({ status: "rejected" });
  });

  it("returns 400 when rejecting with a short reason", async () => {
    mocks.decideLeadDueDiligenceApproval.mockRejectedValueOnce(
      new AppError(400, "Rejection reason must be at least 10 characters")
    );
    const app = createAdminApp();

    const response = await request(app)
      .post("/api/admin/lead-due-diligence-approvals/approval-1/reject")
      .send({ reason: "short" });

    expect(response.status).toBe(400);
    expect(response.body.error.message).toContain("at least 10 characters");
  });

  it("returns 409 when approving an already-decided approval", async () => {
    mocks.decideLeadDueDiligenceApproval.mockRejectedValueOnce(
      new AppError(409, "Due Diligence approval has already been decided")
    );
    const app = createAdminApp();

    const response = await request(app).post("/api/admin/lead-due-diligence-approvals/approval-1/approve");

    expect(response.status).toBe(409);
    expect(response.body.error.message).toContain("already been decided");
  });

  it("requires director access for Due Diligence decisions", async () => {
    mocks.userRole = "rep";
    const app = createAdminApp();

    const approveResponse = await request(app).post("/api/admin/lead-due-diligence-approvals/approval-1/approve");
    const rejectResponse = await request(app)
      .post("/api/admin/lead-due-diligence-approvals/approval-1/reject")
      .send({ reason: "Not enough information." });

    expect(approveResponse.status).toBe(403);
    expect(rejectResponse.status).toBe(403);
    expect(mocks.decideLeadDueDiligenceApproval).not.toHaveBeenCalled();
  });

  it("allows directors to read notification recipient groups", async () => {
    mocks.userRole = "director";
    const app = createAdminApp();

    const response = await request(app).get("/api/admin/notification-recipient-groups/lead_due_diligence");

    expect(response.status).toBe(200);
    expect(mocks.getNotificationRecipientGroup).toHaveBeenCalledWith(expect.anything(), "lead_due_diligence");
    expect(response.body).toMatchObject(recipientGroupResult);
  });

  it("allows admins to read notification recipient groups", async () => {
    const app = createAdminApp();

    const response = await request(app).get("/api/admin/notification-recipient-groups/lead_due_diligence");

    expect(response.status).toBe(200);
    expect(mocks.getNotificationRecipientGroup).toHaveBeenCalledWith(expect.anything(), "lead_due_diligence");
  });

  it("blocks reps from reading notification recipient groups", async () => {
    mocks.userRole = "rep";
    const app = createAdminApp();

    const response = await request(app).get("/api/admin/notification-recipient-groups/lead_due_diligence");

    expect(response.status).toBe(403);
    expect(mocks.getNotificationRecipientGroup).not.toHaveBeenCalled();
  });

  it("returns 404 for an unknown notification recipient group", async () => {
    mocks.getNotificationRecipientGroup.mockRejectedValueOnce(
      new AppError(404, "Notification recipient group not found")
    );
    const app = createAdminApp();

    const response = await request(app).get("/api/admin/notification-recipient-groups/unknown");

    expect(response.status).toBe(404);
    expect(response.body.error.message).toContain("not found");
  });

  it("allows admins to replace notification recipient assignments", async () => {
    const app = createAdminApp();

    const response = await request(app)
      .put("/api/admin/notification-recipient-groups/lead_due_diligence/assignments")
      .send({ userIds: ["director-1", "admin-1"] });

    expect(response.status).toBe(200);
    expect(mocks.updateNotificationRecipientAssignments).toHaveBeenCalledWith(
      expect.anything(),
      "lead_due_diligence",
      ["director-1", "admin-1"]
    );
  });

  it("blocks directors from updating notification recipient assignments", async () => {
    mocks.userRole = "director";
    const app = createAdminApp();

    const response = await request(app)
      .put("/api/admin/notification-recipient-groups/lead_due_diligence/assignments")
      .send({ userIds: ["director-1"] });

    expect(response.status).toBe(403);
    expect(mocks.updateNotificationRecipientAssignments).not.toHaveBeenCalled();
  });

  it("returns 400 when updating notification recipients with an invalid user id", async () => {
    mocks.updateNotificationRecipientAssignments.mockRejectedValueOnce(
      new AppError(400, "Invalid user ID(s): missing-user. These users do not exist in the system.")
    );
    const app = createAdminApp();

    const response = await request(app)
      .put("/api/admin/notification-recipient-groups/lead_due_diligence/assignments")
      .send({ userIds: ["missing-user"] });

    expect(response.status).toBe(400);
    expect(response.body.error.message).toContain("Invalid user ID");
  });

  it("allows admins to clear notification recipient assignments", async () => {
    const app = createAdminApp();

    const response = await request(app)
      .put("/api/admin/notification-recipient-groups/lead_due_diligence/assignments")
      .send({ userIds: [] });

    expect(response.status).toBe(200);
    expect(mocks.updateNotificationRecipientAssignments).toHaveBeenCalledWith(
      expect.anything(),
      "lead_due_diligence",
      []
    );
  });

  it("passes comma-separated Procore sync status filters to the photo audit service with other filters", async () => {
    mocks.getAdminPhotoAuditEvents.mockResolvedValueOnce({
      events: [
        {
          id: "audit-1",
          eventType: "procore_sync_failed",
          userId: "user-1",
          userName: "Admin User",
          userAvatarUrl: null,
          createdAt: "2026-05-01T00:00:00.000Z",
          ipAddress: null,
          userAgent: null,
          metadata: {},
          photo: { id: "photo-1" },
          deal: { id: "deal-1" },
        },
      ],
      total: 1,
      page: 2,
      perPage: 25,
    });
    const app = createAdminApp();

    const response = await request(app).get(
      "/api/admin/photo-audit?procoreSyncStatus=failed,pending&userId=user-1&eventType=uploaded,not-real&from=2026-05-01&to=2026-05-02&dealId=deal-1&photoId=photo-1&page=2&perPage=25"
    );

    expect(response.status).toBe(200);
    expect(response.body.total).toBe(1);
    expect(mocks.getAdminPhotoAuditEvents).toHaveBeenCalledWith(expect.anything(), {
      userIds: ["user-1"],
      eventTypes: ["uploaded"],
      from: "2026-05-01",
      to: "2026-05-02",
      dealId: "deal-1",
      photoId: "photo-1",
      procoreSyncStatuses: ["failed", "pending"],
      page: 2,
      perPage: 25,
    });
  });

  it("leaves photo audit Procore status filters empty when omitted and passes invalid values through", async () => {
    const app = createAdminApp();

    const unfiltered = await request(app).get("/api/admin/photo-audit");
    const invalid = await request(app).get("/api/admin/photo-audit?procoreSyncStatus=bogus,synced");

    expect(unfiltered.status).toBe(200);
    expect(invalid.status).toBe(200);
    expect(mocks.getAdminPhotoAuditEvents).toHaveBeenNthCalledWith(1, expect.anything(), expect.objectContaining({ procoreSyncStatuses: [] }));
    expect(mocks.getAdminPhotoAuditEvents).toHaveBeenNthCalledWith(2, expect.anything(), expect.objectContaining({ procoreSyncStatuses: ["bogus", "synced"] }));
  });

  it("requires CRM auth for manual Procore photo retry", async () => {
    mocks.authDisabled = true;
    const app = createAdminApp();

    const response = await request(app).post("/api/admin/photos/00000000-0000-4000-8000-000000000001/procore-retry");

    expect(response.status).toBe(401);
    expect(mocks.tenantClient.query).not.toHaveBeenCalled();
  });

  it("blocks field contractors from manual Procore photo retry", async () => {
    mocks.userRole = "field_contractor";
    const app = createAdminApp();

    const response = await request(app).post("/api/admin/photos/00000000-0000-4000-8000-000000000001/procore-retry");

    expect(response.status).toBe(403);
    expect(response.body.error.message).toContain("CRM access required");
    expect(mocks.tenantClient.query).not.toHaveBeenCalled();
  });

  it("returns 404 when manual Procore retry cannot find the photo in the scoped tenant", async () => {
    mocks.tenantClient.query.mockResolvedValueOnce({ rows: [] });
    const app = createAdminApp();

    const response = await request(app).post("/api/admin/photos/00000000-0000-4000-8000-000000000001/procore-retry");

    expect(response.status).toBe(404);
    expect(response.body.error.message).toContain("Photo not found");
    expect(mocks.logPhotoEvent).not.toHaveBeenCalled();
  });

  it("returns 400 when manual Procore retry targets a deal without a Procore project", async () => {
    mocks.tenantClient.query.mockResolvedValueOnce({ rows: [{ id: "photo-1", deal_id: "deal-1", procore_sync_status: "failed", procore_project_id: null }] });
    const app = createAdminApp();

    const response = await request(app).post("/api/admin/photos/00000000-0000-4000-8000-000000000001/procore-retry");

    expect(response.status).toBe(400);
    expect(response.body.error.message).toContain("Deal is not linked");
    expect(mocks.logPhotoEvent).not.toHaveBeenCalled();
  });

  it.each(["failed", "pending", "synced"])("forces manual Procore retry for a %s photo and writes an audit event", async (previousStatus) => {
    const photoId = "00000000-0000-4000-8000-000000000001";
    mocks.tenantClient.query
      .mockResolvedValueOnce({ rows: [{ id: photoId, deal_id: "deal-1", procore_sync_status: previousStatus, procore_project_id: 12345 }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: 77 }] });
    const app = createAdminApp();

    const response = await request(app)
      .post(`/api/admin/photos/${photoId}/procore-retry`)
      .set("User-Agent", "vitest-agent");

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ queued: true, photoId, status: "pending" });
    expect(mocks.tenantClient.query).toHaveBeenNthCalledWith(2, expect.stringContaining("procore_sync_status = 'pending'"), [photoId]);
    expect(mocks.tenantClient.query).toHaveBeenNthCalledWith(
      3,
      expect.stringContaining("procore_photo_sync"),
      [expect.stringContaining(`"photoId":"${photoId}"`), "office-1"]
    );
    expect(mocks.logPhotoEvent).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      photoId,
      eventType: "procore_sync_retry_requested",
      userId: "user-1",
      userAgent: "vitest-agent",
      metadata: { previousStatus, jobId: 77 },
    }));
    expect(mocks.commitTransaction).toHaveBeenCalled();
  });

  it("does not fail manual Procore retry when audit logging fails", async () => {
    const photoId = "00000000-0000-4000-8000-000000000001";
    mocks.tenantClient.query
      .mockResolvedValueOnce({ rows: [{ id: photoId, deal_id: "deal-1", procore_sync_status: "failed", procore_project_id: 12345 }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: 88 }] });
    mocks.logPhotoEvent.mockRejectedValueOnce(new Error("audit down"));
    const app = createAdminApp();

    const response = await request(app).post(`/api/admin/photos/${photoId}/procore-retry`);

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ queued: true, photoId, status: "pending" });
    expect(mocks.commitTransaction).toHaveBeenCalled();
  });

});
