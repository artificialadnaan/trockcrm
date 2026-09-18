import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Keep the real RBAC middleware and UUID validator in play. These are the two guards that used to be
// verified only by source-text matching; the remaining collaborators are mocked because this test exercises
// the router contract, not a tenant database transaction or the mail outbox implementation.
const mocks = vi.hoisted(() => ({
  assertDealCollaboratorAccess: vi.fn(),
  assertDealOwnerAccess: vi.fn(),
  retriggerCorrectiveActionNotification: vi.fn(),
  buildAuditActorFromUser: vi.fn(),
  logActivity: vi.fn(),
}));

vi.mock("../../../src/lib/collaboration-access.js", () => ({
  assertDealCollaboratorAccess: mocks.assertDealCollaboratorAccess,
  assertDealOwnerAccess: mocks.assertDealOwnerAccess,
  getCollaborativeReadRole: vi.fn(),
  normalizeCollaborativeScope: vi.fn(),
}));

vi.mock("../../../src/modules/field/corrective-actions-service.js", () => ({
  retriggerCorrectiveActionNotification: mocks.retriggerCorrectiveActionNotification,
}));

vi.mock("../../../src/modules/audit/audit-logger.js", () => ({
  buildAuditActorFromUser: mocks.buildAuditActorFromUser,
  logActivity: mocks.logActivity,
}));

import { errorHandler } from "../../../src/middleware/error-handler.js";
import { dealRoutes } from "../../../src/modules/deals/routes.js";

const DEAL_ID = "11111111-1111-4111-8111-111111111111";
const SCORECARD_ID = "22222222-2222-4222-8222-222222222222";
const OFFICE_ID = "33333333-3333-4333-8333-333333333333";
const USER_ID = "44444444-4444-4444-8444-444444444444";
const RETRIGGER_PATH = `/api/deals/${DEAL_ID}/scorecards/${SCORECARD_ID}/corrective-actions/retrigger`;

type TestRole = "rep" | "director" | "admin";

function buildApp(role: TestRole) {
  const tenantDb = {};
  const commitTransaction = vi.fn().mockResolvedValue(undefined);
  const app = express();
  app.use(express.json());
  app.use((req: any, _res, next) => {
    req.user = {
      id: USER_ID,
      email: "director@trock.test",
      displayName: "Director Test",
      role,
      officeId: OFFICE_ID,
      activeOfficeId: OFFICE_ID,
    };
    req.tenantDb = tenantDb;
    req.officeSlug = "test";
    req.commitTransaction = commitTransaction;
    next();
  });
  app.use("/api/deals", dealRoutes);
  app.use(errorHandler);

  return { app, tenantDb, commitTransaction };
}

function queuedResult(overrides: Record<string, unknown> = {}) {
  return {
    queued: true,
    alreadyQueued: false,
    priorCycleNonce: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    newCycleNonce: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    dealName: "North Dallas Fire Demo",
    dealNumber: "DEAL-42",
    projectNumber: "DFW-42",
    ...overrides,
  };
}

describe("corrective-action email retrigger route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.assertDealCollaboratorAccess.mockResolvedValue({ id: DEAL_ID });
    mocks.retriggerCorrectiveActionNotification.mockResolvedValue(queuedResult());
    mocks.buildAuditActorFromUser.mockImplementation((input) => ({ type: "user", ...input }));
    mocks.logActivity.mockResolvedValue(undefined);
  });

  it("actually blocks a rep at requireDirector before access or the retrigger helper run", async () => {
    const { app, commitTransaction } = buildApp("rep");

    const response = await request(app).post(RETRIGGER_PATH);

    expect(response.status).toBe(403);
    expect(response.body).toEqual({ error: { message: "Requires one of: admin, director" } });
    expect(mocks.assertDealCollaboratorAccess).not.toHaveBeenCalled();
    expect(mocks.retriggerCorrectiveActionNotification).not.toHaveBeenCalled();
    expect(mocks.logActivity).not.toHaveBeenCalled();
    expect(commitTransaction).not.toHaveBeenCalled();
  });

  it("lets a director queue the repair, audit it, commit it, and return 202", async () => {
    const { app, tenantDb, commitTransaction } = buildApp("director");

    const response = await request(app)
      .post(RETRIGGER_PATH)
      .set("User-Agent", "qc-retrigger-route-test");

    expect(response.status).toBe(202);
    expect(response.body).toEqual({ queued: true, alreadyQueued: false });
    expect(mocks.assertDealCollaboratorAccess).toHaveBeenCalledWith(
      tenantDb,
      DEAL_ID,
      expect.objectContaining({ id: USER_ID, role: "director" }),
    );
    expect(mocks.retriggerCorrectiveActionNotification).toHaveBeenCalledWith(tenantDb, {
      dealId: DEAL_ID,
      scorecardId: SCORECARD_ID,
      office: { id: OFFICE_ID, slug: "test" },
    });
    expect(mocks.buildAuditActorFromUser).toHaveBeenCalledWith({
      userId: USER_ID,
      name: "Director Test",
      role: "director",
    });
    expect(mocks.logActivity).toHaveBeenCalledWith(expect.objectContaining({
      tenantDb,
      action: "update",
      entity: {
        tableName: "deals",
        entityType: "deal",
        recordId: DEAL_ID,
        nameSnapshot: "North Dallas Fire Demo",
        secondaryIdSnapshot: "DFW-42",
      },
      fieldChanges: {
        correctiveActionEmailCycle: {
          from: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          to: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        },
      },
      metadata: {
        operation: "corrective_action_email_retriggered",
        scorecardId: SCORECARD_ID,
        priorCycleNonce: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        newCycleNonce: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      },
      userAgent: "qc-retrigger-route-test",
    }));
    expect(commitTransaction).toHaveBeenCalledOnce();
  });

  it("returns 200 for an already-current queued cycle and does not write a duplicate audit entry", async () => {
    mocks.retriggerCorrectiveActionNotification.mockResolvedValueOnce(
      queuedResult({ queued: false, alreadyQueued: true }),
    );
    const { app, commitTransaction } = buildApp("director");

    const response = await request(app).post(RETRIGGER_PATH);

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ queued: false, alreadyQueued: true });
    expect(mocks.retriggerCorrectiveActionNotification).toHaveBeenCalledOnce();
    expect(mocks.logActivity).not.toHaveBeenCalled();
    expect(commitTransaction).toHaveBeenCalledOnce();
  });

  it("rejects an invalid UUID before collaborator access or the retrigger helper", async () => {
    const { app, commitTransaction } = buildApp("director");

    const response = await request(app).post(
      `/api/deals/not-a-uuid/scorecards/${SCORECARD_ID}/corrective-actions/retrigger`,
    );

    expect(response.status).toBe(400);
    expect(response.body).toEqual({ error: { message: "Invalid dealId: must be a UUID." } });
    expect(mocks.assertDealCollaboratorAccess).not.toHaveBeenCalled();
    expect(mocks.retriggerCorrectiveActionNotification).not.toHaveBeenCalled();
    expect(mocks.logActivity).not.toHaveBeenCalled();
    expect(commitTransaction).not.toHaveBeenCalled();
  });
});
