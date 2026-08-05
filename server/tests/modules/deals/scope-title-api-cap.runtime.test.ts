// The scope-title length cap, proven at the API — not the form.
//
// scope_title exists because `description` (text, 5000-char form cap) is a notes field being asked to do
// a title's job, and keeps arriving as a wall of text. The BREVITY is the feature, so the cap has to hold
// for every writer, not just the React form: a script, an importer, or curl would otherwise put the wall
// of text straight back and the column would need widening inside a release.
//
// validateDealPayload is the one validator all three deal write paths already call, so the check lives
// there and this file proves it on each of them:
//     POST /api/deals
//     POST /api/deals/service-opportunity
//     PATCH /api/deals/:id
//
// createDeal/updateDeal are mocked, deliberately: the assertion is that an over-length title never
// REACHES the write, which is only observable if the write is a spy. The column-level backstop
// (varchar(120)) is proven separately against real Postgres in
// tests/migrations/0218-deals-scope-title.runtime.test.ts.
import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEAL_SCOPE_TITLE_MAX_LENGTH } from "@trock-crm/shared/types";

const dealsServiceMocks = vi.hoisted(() => ({
  createDeal: vi.fn(),
  getDealById: vi.fn(),
  updateDeal: vi.fn(),
}));
const pipelineServiceMocks = vi.hoisted(() => ({
  getStageBySlug: vi.fn(),
  getActiveProjectTypes: vi.fn(),
}));
const scopingServiceMocks = vi.hoisted(() => ({
  assertDealScopingWriteAllowed: vi.fn(),
}));
const accessMocks = vi.hoisted(() => ({
  assertDealCollaboratorAccess: vi.fn(),
  assertDealOwnerAccess: vi.fn(),
  getCollaborativeReadRole: vi.fn((role: string) => role),
  normalizeCollaborativeScope: vi.fn(
    (_role: string, scope: "mine" | "team" | "all" | undefined) => scope ?? "all"
  ),
}));

vi.mock("../../../src/events/bus.js", () => ({
  eventBus: {
    emitLocal: vi.fn(),
    on: vi.fn(),
    emit: vi.fn(),
    setMaxListeners: vi.fn(),
  },
}));

vi.mock("../../../src/modules/deals/service.js", async () => {
  const actual = await vi.importActual("../../../src/modules/deals/service.js");
  return {
    ...(actual as Record<string, unknown>),
    createDeal: dealsServiceMocks.createDeal,
    getDealById: dealsServiceMocks.getDealById,
    updateDeal: dealsServiceMocks.updateDeal,
  };
});

vi.mock("../../../src/modules/pipeline/service.js", async () => {
  const actual = await vi.importActual("../../../src/modules/pipeline/service.js");
  return {
    ...(actual as Record<string, unknown>),
    getStageBySlug: pipelineServiceMocks.getStageBySlug,
    getActiveProjectTypes: pipelineServiceMocks.getActiveProjectTypes,
  };
});

vi.mock("../../../src/modules/deals/scoping-service.js", async () => {
  const actual = await vi.importActual("../../../src/modules/deals/scoping-service.js");
  return {
    ...(actual as Record<string, unknown>),
    assertDealScopingWriteAllowed: scopingServiceMocks.assertDealScopingWriteAllowed,
  };
});

vi.mock("../../../src/lib/collaboration-access.js", () => ({
  assertDealCollaboratorAccess: accessMocks.assertDealCollaboratorAccess,
  assertDealOwnerAccess: accessMocks.assertDealOwnerAccess,
  getCollaborativeReadRole: accessMocks.getCollaborativeReadRole,
  normalizeCollaborativeScope: accessMocks.normalizeCollaborativeScope,
}));

const { dealRoutes } = await import("../../../src/modules/deals/routes.js");
const { errorHandler } = await import("../../../src/middleware/error-handler.js");

const DEAL_ID = "11111111-1111-4111-8111-111111111111";
const REP_ID = "22222222-2222-4222-8222-222222222222";
const COMPANY_ID = "33333333-3333-4333-8333-333333333333";
const PROPERTY_ID = "44444444-4444-4444-8444-444444444444";

const AT_LIMIT = "A".repeat(DEAL_SCOPE_TITLE_MAX_LENGTH);
const OVER_LIMIT = "A".repeat(DEAL_SCOPE_TITLE_MAX_LENGTH + 1);

/** The service-opportunity route reads company/property rows before it forwards to createDeal. */
function createTenantDb() {
  const queue: unknown[][] = [
    [{ id: COMPANY_ID, isActive: true }],
    [{ id: PROPERTY_ID, companyId: COMPANY_ID, isActive: true }],
  ];
  return {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn(() => Promise.resolve(queue.shift() ?? [])),
        })),
      })),
    })),
  };
}

function createApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).user = {
      id: "admin-1",
      role: "admin",
      displayName: "Admin",
      email: "admin@example.com",
      officeId: "office-dallas",
      activeOfficeId: "office-dallas",
    };
    (req as any).officeSlug = "dallas";
    (req as any).tenantDb = createTenantDb();
    (req as any).commitTransaction = vi.fn().mockResolvedValue(undefined);
    next();
  });
  app.use("/api/deals", dealRoutes);
  app.use(errorHandler);
  return app;
}

function postDeal(body: Record<string, unknown>) {
  return request(createApp())
    .post("/api/deals")
    .send({ name: "Scope title probe", stageId: "stage-opportunity", assignedRepId: REP_ID, ...body });
}

function postServiceOpportunity(body: Record<string, unknown>) {
  return request(createApp())
    .post("/api/deals/service-opportunity")
    .send({
      name: "Scope title probe",
      assignedRepId: REP_ID,
      companyId: COMPANY_ID,
      propertyId: PROPERTY_ID,
      ...body,
    });
}

function patchDeal(body: Record<string, unknown>) {
  return request(createApp()).patch(`/api/deals/${DEAL_ID}`).send(body);
}

beforeEach(() => {
  vi.clearAllMocks();
  dealsServiceMocks.createDeal.mockResolvedValue({
    id: DEAL_ID,
    name: "Created",
    officeCode: "dfw",
    hubspotDealId: null,
  });
  dealsServiceMocks.updateDeal.mockResolvedValue({
    id: DEAL_ID,
    name: "Updated",
    hubspotDealId: null,
  });
  dealsServiceMocks.getDealById.mockResolvedValue({
    id: DEAL_ID,
    name: "Existing",
    assignedRepId: REP_ID,
    companyId: COMPANY_ID,
    propertyId: PROPERTY_ID,
    sourceLeadId: null,
    hubspotDealId: null,
  });
  accessMocks.assertDealCollaboratorAccess.mockResolvedValue({ assignedRepId: "admin-1" });
  accessMocks.assertDealOwnerAccess.mockResolvedValue(undefined);
  scopingServiceMocks.assertDealScopingWriteAllowed.mockResolvedValue(null);
  pipelineServiceMocks.getStageBySlug.mockResolvedValue({
    id: "stage-opportunity",
    slug: "opportunity",
    name: "Opportunity",
  });
  pipelineServiceMocks.getActiveProjectTypes.mockResolvedValue([
    { id: "pt-service", slug: "service", name: "Service" },
  ]);
});

describe("scopeTitle length cap — POST /api/deals", () => {
  it(`rejects ${DEAL_SCOPE_TITLE_MAX_LENGTH + 1} characters with a 400 and never calls createDeal`, async () => {
    const res = await postDeal({ scopeTitle: OVER_LIMIT });

    expect(res.status).toBe(400);
    expect(res.body.error?.code ?? res.body.code).toBe("SCOPE_TITLE_INVALID");
    expect(res.body.error?.message ?? res.body.message).toContain(
      `${DEAL_SCOPE_TITLE_MAX_LENGTH} characters or fewer`
    );
    expect(dealsServiceMocks.createDeal).not.toHaveBeenCalled();
  });

  it(`accepts exactly ${DEAL_SCOPE_TITLE_MAX_LENGTH} characters and forwards them`, async () => {
    const res = await postDeal({ scopeTitle: AT_LIMIT });

    expect(res.status).toBe(201);
    const forwarded = dealsServiceMocks.createDeal.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(forwarded.scopeTitle).toBe(AT_LIMIT);
  });

  it("measures the TRIMMED value, so surrounding whitespace cannot push a legal title over", async () => {
    const res = await postDeal({ scopeTitle: `   ${AT_LIMIT}   ` });

    expect(res.status).toBe(201);
    const forwarded = dealsServiceMocks.createDeal.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(forwarded.scopeTitle).toBe(AT_LIMIT);
  });

  it("normalizes a blank / whitespace-only title to null rather than storing an empty string", async () => {
    for (const blank of ["", "   "]) {
      vi.clearAllMocks();
      dealsServiceMocks.createDeal.mockResolvedValue({ id: DEAL_ID, name: "Created", officeCode: "dfw" });

      const res = await postDeal({ scopeTitle: blank });

      expect(res.status).toBe(201);
      const forwarded = dealsServiceMocks.createDeal.mock.calls[0]?.[1] as Record<string, unknown>;
      expect(forwarded.scopeTitle).toBeNull();
    }
  });

  it("rejects a non-string title instead of coercing it into the column", async () => {
    for (const bad of [42, true, { title: "nope" }, ["Balcony Repair"]]) {
      vi.clearAllMocks();
      const res = await postDeal({ scopeTitle: bad });

      expect(res.status).toBe(400);
      expect(dealsServiceMocks.createDeal).not.toHaveBeenCalled();
    }
  });

  it("accepts a real short title verbatim", async () => {
    const res = await postDeal({ scopeTitle: "Balcony Repair" });

    expect(res.status).toBe(201);
    const forwarded = dealsServiceMocks.createDeal.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(forwarded.scopeTitle).toBe("Balcony Repair");
  });
});

describe("scopeTitle length cap — POST /api/deals/service-opportunity", () => {
  it(`rejects ${DEAL_SCOPE_TITLE_MAX_LENGTH + 1} characters with a 400 and never calls createDeal`, async () => {
    const res = await postServiceOpportunity({ scopeTitle: OVER_LIMIT });

    expect(res.status).toBe(400);
    expect(dealsServiceMocks.createDeal).not.toHaveBeenCalled();
  });

  it("forwards a legal title through the direct-create path", async () => {
    const res = await postServiceOpportunity({ scopeTitle: "Plumbing Renovations" });

    expect(res.status).toBe(201);
    const forwarded = dealsServiceMocks.createDeal.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(forwarded.scopeTitle).toBe("Plumbing Renovations");
  });
});

describe("scopeTitle length cap — PATCH /api/deals/:id", () => {
  it(`rejects ${DEAL_SCOPE_TITLE_MAX_LENGTH + 1} characters with a 400 and never calls updateDeal`, async () => {
    const res = await patchDeal({ scopeTitle: OVER_LIMIT });

    expect(res.status).toBe(400);
    expect(res.body.error?.code ?? res.body.code).toBe("SCOPE_TITLE_INVALID");
    expect(dealsServiceMocks.updateDeal).not.toHaveBeenCalled();
  });

  it(`accepts exactly ${DEAL_SCOPE_TITLE_MAX_LENGTH} characters on edit`, async () => {
    const res = await patchDeal({ scopeTitle: AT_LIMIT });

    expect(res.status).toBe(200);
    const forwarded = dealsServiceMocks.updateDeal.mock.calls[0]?.[2] as Record<string, unknown>;
    expect(forwarded.scopeTitle).toBe(AT_LIMIT);
  });

  it("forwards an explicit null so the title can be CLEARED", async () => {
    const res = await patchDeal({ scopeTitle: null });

    expect(res.status).toBe(200);
    const forwarded = dealsServiceMocks.updateDeal.mock.calls[0]?.[2] as Record<string, unknown>;
    expect(forwarded).toHaveProperty("scopeTitle", null);
  });

  it("OMITS scopeTitle entirely when the patch does not mention it — a partial save cannot blank a title", async () => {
    const res = await patchDeal({ winProbability: 40 });

    expect(res.status).toBe(200);
    const forwarded = dealsServiceMocks.updateDeal.mock.calls[0]?.[2] as Record<string, unknown>;
    expect(forwarded).not.toHaveProperty("scopeTitle");
  });
});
