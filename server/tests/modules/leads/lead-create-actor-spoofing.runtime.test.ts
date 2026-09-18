// The lead-create route assigned `actorUserId: req.user!.id` BEFORE spreading `...rest`, so a request could
// post its own `actorUserId` and have createLead persist somebody else as the lead's creator. That looked
// harmless while nothing read the column; the Canvassing Activity report now counts
// leads.created_by_user_id on a per-person scoreboard, which turns it into a way to credit your canvassing
// to a colleague — or bury it on someone else. Found by Codex on PR #1058.
//
// Asserted at the ROUTE, on the object it hands the service: the defect was purely one of spread ORDER, and
// the service is right to persist whatever actor it is given.
import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const ACTOR = "00000000-0000-4000-8000-00000000ac70";
const VICTIM = "00000000-0000-4000-8000-00000000b1c0";

const mocks = vi.hoisted(() => ({
  createLead: vi.fn(async () => ({ id: "lead-1", verificationStatus: "not_required", stageId: "s1" })),
}));

vi.mock("../../../src/modules/leads/service.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../src/modules/leads/service.js")>();
  return { ...actual, createLead: mocks.createLead };
});

const { leadRoutes } = await import("../../../src/modules/leads/routes.js");

function app() {
  const a = express();
  a.use(express.json());
  a.use((req: any, _res, next) => {
    req.user = {
      id: ACTOR,
      email: "emccarty@trockgc.com",
      role: "rep",
      displayName: "Edward McCarty",
      officeId: "office-dallas",
      activeOfficeId: "office-dallas",
    };
    req.tenantDb = { execute: vi.fn().mockResolvedValue({ rows: [] }) };
    req.commitTransaction = vi.fn().mockResolvedValue(undefined);
    req.officeSlug = "dallas";
    next();
  });
  a.use("/leads", leadRoutes);
  a.use((err: any, _req: any, res: any, _next: any) => res.status(err?.statusCode ?? 500).json({ error: err?.message }));
  return a;
}

beforeEach(() => vi.clearAllMocks());

describe("POST /leads — creator attribution", () => {
  it("records the SESSION user as the actor, ignoring an actorUserId posted in the body", async () => {
    await request(app())
      .post("/leads")
      .send({
        companyId: "00000000-0000-4000-8000-00000000c001",
        propertyId: "00000000-0000-4000-8000-00000000b00a",
        name: "Canvassed building",
        actorUserId: VICTIM,
      });

    expect(mocks.createLead).toHaveBeenCalled();
    const payload = mocks.createLead.mock.calls[0]?.[1] as unknown as Record<string, unknown>;
    expect(payload.actorUserId).toBe(ACTOR);
    expect(payload.actorUserId).not.toBe(VICTIM);
  });

  it("ignores an officeId posted in the body too — same spread-order class", async () => {
    await request(app())
      .post("/leads")
      .send({
        companyId: "00000000-0000-4000-8000-00000000c001",
        propertyId: "00000000-0000-4000-8000-00000000b00a",
        name: "Canvassed building",
        officeId: "office-somewhere-else",
      });

    const payload = mocks.createLead.mock.calls[0]?.[1] as unknown as Record<string, unknown>;
    expect(payload.officeId).toBe("office-dallas");
  });
});
