// The scope-title cap on POST /api/leads/:id/convert.
//
// The convert route builds a deal but does NOT go through the deals module's validateDealPayload — it
// forwards its own field list into convertLead. So threading scopeTitle through it without a check would
// have handed the varchar(120) an unbounded string: a 22001 surfacing as a 500 the user cannot act on,
// on the one deal-creation flow with no deal form behind it.
//
// That hazard was, for two rounds, my stated reason NOT to thread the field here. It was the wrong
// conclusion — it is a reason to add the validation, which is what this pins.
import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEAL_SCOPE_TITLE_MAX_LENGTH } from "@trock-crm/shared/types";

const conversionMocks = vi.hoisted(() => ({ convertLead: vi.fn() }));
const accessMocks = vi.hoisted(() => ({
  assertLeadCollaboratorAccess: vi.fn(),
  assertLeadOwnerAccess: vi.fn(),
  getCollaborativeReadRole: vi.fn((role: string) => role),
  normalizeCollaborativeScope: vi.fn(
    (_role: string, scope: "mine" | "team" | "all" | undefined) => scope ?? "all"
  ),
}));

vi.mock("../../../src/modules/leads/conversion-service.js", () => ({
  convertLead: conversionMocks.convertLead,
}));

vi.mock("../../../src/lib/collaboration-access.js", () => ({
  assertLeadCollaboratorAccess: accessMocks.assertLeadCollaboratorAccess,
  assertLeadOwnerAccess: accessMocks.assertLeadOwnerAccess,
  getCollaborativeReadRole: accessMocks.getCollaborativeReadRole,
  normalizeCollaborativeScope: accessMocks.normalizeCollaborativeScope,
}));

vi.mock("../../../src/events/bus.js", () => ({
  eventBus: { emitLocal: vi.fn(), on: vi.fn(), emit: vi.fn(), setMaxListeners: vi.fn() },
}));

const { leadRoutes } = await import("../../../src/modules/leads/routes.js");
const { errorHandler } = await import("../../../src/middleware/error-handler.js");

const LEAD_ID = "11111111-1111-4111-8111-111111111111";
const AT_LIMIT = "A".repeat(DEAL_SCOPE_TITLE_MAX_LENGTH);
const OVER_LIMIT = "A".repeat(DEAL_SCOPE_TITLE_MAX_LENGTH + 1);

function createApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).user = {
      id: "rep-1",
      role: "rep",
      displayName: "Rep One",
      email: "rep@example.com",
      officeId: "office-dallas",
      activeOfficeId: "office-dallas",
    };
    (req as any).officeSlug = "dallas";
    (req as any).tenantDb = {};
    (req as any).commitTransaction = vi.fn().mockResolvedValue(undefined);
    next();
  });
  app.use("/api/leads", leadRoutes);
  app.use(errorHandler);
  return app;
}

function convert(body: Record<string, unknown>) {
  return request(createApp()).post(`/api/leads/${LEAD_ID}/convert`).send(body);
}

/** The field list handed to convertLead on the call under test. */
function forwarded() {
  return conversionMocks.convertLead.mock.calls[0]?.[1] as Record<string, unknown>;
}

beforeEach(() => {
  vi.clearAllMocks();
  conversionMocks.convertLead.mockResolvedValue({
    lead: { id: LEAD_ID, name: "Palm Villas" },
    deal: { id: "22222222-2222-4222-8222-222222222222" },
  });
  accessMocks.assertLeadOwnerAccess.mockResolvedValue(undefined);
  accessMocks.assertLeadCollaboratorAccess.mockResolvedValue(undefined);
});

describe("POST /api/leads/:id/convert — scope title", () => {
  it("forwards a scope title captured on the convert dialog", async () => {
    const res = await convert({ scopeTitle: "Exterior Renovation" });

    expect(res.status).toBe(201);
    expect(forwarded().scopeTitle).toBe("Exterior Renovation");
  });

  it(`rejects ${DEAL_SCOPE_TITLE_MAX_LENGTH + 1} characters with a 400 and never converts`, async () => {
    const res = await convert({ scopeTitle: OVER_LIMIT });

    expect(res.status).toBe(400);
    expect(res.body.error?.code ?? res.body.code).toBe("SCOPE_TITLE_INVALID");
    // The lead must NOT be converted by a request that failed validation — a half-applied convert would
    // leave a lead marked converted behind a deal that was never created.
    expect(conversionMocks.convertLead).not.toHaveBeenCalled();
  });

  it(`accepts exactly ${DEAL_SCOPE_TITLE_MAX_LENGTH} characters`, async () => {
    const res = await convert({ scopeTitle: AT_LIMIT });

    expect(res.status).toBe(201);
    expect(forwarded().scopeTitle).toBe(AT_LIMIT);
  });

  it("trims before measuring, matching the deal routes exactly", async () => {
    const res = await convert({ scopeTitle: `   ${AT_LIMIT}   ` });

    expect(res.status).toBe(201);
    expect(forwarded().scopeTitle).toBe(AT_LIMIT);
  });

  it("normalizes blank to null rather than storing an empty string", async () => {
    const res = await convert({ scopeTitle: "   " });

    expect(res.status).toBe(201);
    expect(forwarded().scopeTitle).toBeNull();
  });

  it("rejects a non-string instead of coercing it toward the column", async () => {
    const res = await convert({ scopeTitle: { nope: true } });

    expect(res.status).toBe(400);
    expect(conversionMocks.convertLead).not.toHaveBeenCalled();
  });

  it("OMITS the key entirely when the caller does not send one — the pre-existing bare confirm", async () => {
    // convertLeadToOpportunity posts no body at all when the field is blank. The route must not
    // manufacture a null: conversion-service keys on `?? undefined`, and an absent key keeps that path
    // identical to how every existing caller behaved.
    const res = await convert({});

    expect(res.status).toBe(201);
    expect(forwarded()).not.toHaveProperty("scopeTitle");
  });
});
