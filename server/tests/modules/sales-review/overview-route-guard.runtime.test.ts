// Proves GET /sales-review is role-gated, and gated to the SAME set the report index offers it to.
//
// This route had no role check at all. That was survivable while nothing linked to it, but the overview it
// returns is team-wide: buildSalesReviewOverview only narrows to the caller when `role === "rep"`, and the
// route reached that call through `req.user!.role as "admin" | "director" | "rep"` — a cast, which asserts
// the shape rather than testing it. A `construction` user (requireCrmUser admits them to every CRM mount)
// matched no self-scoping branch and was handed the whole team's forecast, hygiene list and named-rep
// activity. Listing the report on the index is what made that reachable by anyone not typing the URL.
//
// The data layer is the only thing stubbed, so a 200 here means the request cleared every guard on the route.
import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const serviceMocks = vi.hoisted(() => ({
  getSalesReviewOverview: vi.fn(async () => ({ newOpportunities: [], forecast: [], hygiene: [] })),
}));

vi.mock("../../../src/modules/sales-review/service.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../src/modules/sales-review/service.js")>();
  return { ...actual, getSalesReviewOverview: serviceMocks.getSalesReviewOverview };
});

const { salesReviewRoutes } = await import("../../../src/modules/sales-review/routes.js");

type FakeUser = { id: string; email: string; role: string; baseRole: string };

function appAs(user: FakeUser | null) {
  const app = express();
  app.use((req: any, _res, next) => {
    if (user) req.user = user;
    req.tenantDb = { execute: vi.fn().mockResolvedValue({ rows: [] }) };
    req.commitTransaction = vi.fn().mockResolvedValue(undefined);
    req.officeSlug = "dallas";
    next();
  });
  app.use("/sales-review", salesReviewRoutes);
  app.use((err: any, _req: any, res: any, _next: any) => {
    res.status(err?.statusCode ?? 500).json({ error: err?.message });
  });
  return app;
}

function userWithRole(role: string): FakeUser {
  return { id: `u-${role}`, email: `${role}@trockgc.com`, role, baseRole: role };
}

describe("GET /sales-review — role gate", () => {
  beforeEach(() => vi.clearAllMocks());

  // The same three roles the index card is listed for, and the same three every sibling report route
  // (monday-showcase, qc-reports, field-team) admits.
  for (const role of ["admin", "director", "rep"]) {
    it(`serves a ${role}`, async () => {
      const res = await request(appAs(userWithRole(role))).get("/sales-review");

      expect(res.status).toBe(200);
      expect(serviceMocks.getSalesReviewOverview).toHaveBeenCalledTimes(1);
    });
  }

  // The bug this suite exists for. Asserting the service was never CALLED matters as much as the status:
  // a 403 rendered after the query still means the team's numbers were assembled for someone who may not
  // see them, and any later change that moved the response earlier would leak them.
  for (const role of ["construction", "field_contractor"]) {
    it(`refuses a ${role} user without building the overview`, async () => {
      const res = await request(appAs(userWithRole(role))).get("/sales-review");

      expect(res.status).toBe(403);
      expect(serviceMocks.getSalesReviewOverview).not.toHaveBeenCalled();
    });
  }

  it("refuses an unauthenticated request", async () => {
    const res = await request(appAs(null)).get("/sales-review");

    expect(res.status).toBe(403);
    expect(serviceMocks.getSalesReviewOverview).not.toHaveBeenCalled();
  });

  // A rep is admitted, but the route must keep handing the service the rep's OWN identity — that argument is
  // the only thing making the overview self-scoped. Admitting reps while passing a blank actor would turn
  // the gate into a way IN rather than a narrowing.
  it("passes a rep's own identity through, which is what self-scopes the overview", async () => {
    await request(appAs(userWithRole("rep"))).get("/sales-review");

    const actor = serviceMocks.getSalesReviewOverview.mock.calls[0]?.[2] as { role: string; userId: string };
    expect(actor).toEqual({ role: "rep", userId: "u-rep" });
  });
});
