import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";

// Field auth: inject a field user, skip JWT/office resolution.
vi.mock("../../../src/middleware/field-auth.js", () => ({
  requireFieldContractor: (req: any, _res: any, next: (err?: unknown) => void) => {
    req.fieldUser = { id: "user-1", role: "field_contractor" };
    next();
  },
}));

// Control the office fan-out: two offices return projects, a third fails (degrade gracefully).
// officeTag / withResolvedOffice keep their real implementations.
vi.mock("../../../src/modules/field/cross-office.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../src/modules/field/cross-office.js")>();
  return {
    ...actual,
    fanOutActiveOffices: vi.fn(async () => ({
      results: [
        {
          office: { id: "id-dallas", slug: "dallas" },
          value: {
            projects: [{ id: "deal-dallas", name: "Jasonn Ranches", lastActivityAt: "2026-06-11T00:00:00.000Z" }],
            total: 1,
            page: 1,
            perPage: 50,
          },
        },
        {
          office: { id: "id-atlanta", slug: "atlanta" },
          value: {
            projects: [{ id: "deal-atlanta", name: "Peachtree Lofts", lastActivityAt: "2026-06-10T00:00:00.000Z" }],
            total: 1,
            page: 1,
            perPage: 50,
          },
        },
      ],
      failures: [{ office: { id: "id-pw", slug: "pwauditoffice" }, error: "schema unavailable" }],
    })),
  };
});

const { fieldRoutes } = await import("../../../src/modules/field/routes.js");

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/field", fieldRoutes);
  app.use((err: any, _req: any, res: any, _next: any) => {
    res.status(err?.statusCode ?? 500).json({ error: { message: err?.message ?? "error" } });
  });
  return app;
}

describe("GET /api/field/projects (cross-office)", () => {
  it("returns projects from ALL offices, each tagged with its owning office, and surfaces degraded offices", async () => {
    const res = await request(buildApp()).get("/api/field/projects");

    expect(res.status).toBe(200);
    // Both offices' projects are returned, merged newest-first.
    expect(res.body.projects.map((p: any) => p.id)).toEqual(["deal-dallas", "deal-atlanta"]);
    // Every result is stamped with its owning office (disambiguation — names/numbers are per-schema unique).
    expect(res.body.projects[0]).toMatchObject({ id: "deal-dallas", officeSlug: "dallas", officeId: "id-dallas" });
    expect(res.body.projects[1]).toMatchObject({ id: "deal-atlanta", officeSlug: "atlanta", officeId: "id-atlanta" });
    // Totals summed across offices.
    expect(res.body.total).toBe(2);
    // One office failing does NOT fail the read — it's surfaced as degraded.
    expect(res.body.degradedOffices).toEqual(["pwauditoffice"]);
  });
});
