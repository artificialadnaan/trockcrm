import request from "supertest";
import express from "express";
import { beforeEach, describe, expect, it, vi } from "vitest";

const fanOutActiveOfficesMock = vi.hoisted(() => vi.fn());

// Field auth: authenticate as a field contractor (no real token needed).
vi.mock("../src/middleware/field-auth.js", () => ({
  requireFieldContractor: (req: any, _res: any, next: () => void) => {
    req.fieldUser = { id: "field-user-1", role: "field_contractor", tenantId: "office-home" };
    next();
  },
  requireCrmUser: (_req: any, _res: any, next: () => void) => next(),
}));

// Stub the cross-office layer. assertFanOutNotFullyDegraded + officeTag stay REAL (re-exported) so the
// route's degradation guard and office stamping behave like production; only the DB fan-out is canned.
vi.mock("../src/modules/field/cross-office.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/modules/field/cross-office.js")>();
  return {
    ...actual,
    fanOutActiveOffices: fanOutActiveOfficesMock,
  };
});

const { fieldRoutes } = await import("../src/modules/field/routes.js");
const { errorHandler } = await import("../src/middleware/error-handler.js");

function app() {
  const a = express();
  a.use(express.json());
  a.use("/api/field", fieldRoutes);
  a.use(errorHandler); // the REAL handler maps AppError.statusCode -> response status
  return a;
}

const project = (id: string, distanceMiles: number) => ({
  id,
  name: id,
  dealNumber: id,
  projectNumber: id,
  propertyName: null,
  propertyAddress: null,
  stage: "Active",
  lastActivityAt: null,
  photoCount: 0,
  starred: false,
  distanceMiles,
});

describe("GET /api/field/projects/nearby", () => {
  beforeEach(() => fanOutActiveOfficesMock.mockReset());

  it("returns the global nearest 3 across offices, stamped + distance-sorted", async () => {
    fanOutActiveOfficesMock.mockResolvedValue({
      results: [
        { office: { id: "id-dfw", slug: "dfw" }, value: { projects: [project("a", 1), project("c", 9)] } },
        { office: { id: "id-atl", slug: "atl" }, value: { projects: [project("b", 2), project("d", 4)] } },
      ],
      failures: [],
    });

    const res = await request(app()).get("/api/field/projects/nearby?lat=32.7&lng=-96.8");
    expect(res.status).toBe(200);
    expect(res.body.projects.map((p: any) => p.id)).toEqual(["a", "b", "d"]); // 1 < 2 < 4 < 9, top 3
    expect(res.body.projects[0]).toMatchObject({ officeSlug: "dfw", officeId: "id-dfw" });
    expect(res.body.projects[1]).toMatchObject({ officeSlug: "atl" });
    expect(res.body.degradedOffices).toEqual([]);
  });

  it("rejects out-of-range coordinates with a 400 (not a fan-out 503)", async () => {
    const res = await request(app()).get("/api/field/projects/nearby?lat=999&lng=-96.8");
    expect(res.status).toBe(400);
    expect(fanOutActiveOfficesMock).not.toHaveBeenCalled(); // never fanned out
  });

  it("rejects missing coordinates with a 400", async () => {
    const res = await request(app()).get("/api/field/projects/nearby");
    expect(res.status).toBe(400);
  });

  it("rejects blank coordinate params with a 400 (not (0,0) results)", async () => {
    // `?lat=&lng=` arrives as empty strings; Number("") === 0 must NOT be treated as a valid coordinate.
    const res = await request(app()).get("/api/field/projects/nearby?lat=&lng=");
    expect(res.status).toBe(400);
    expect(fanOutActiveOfficesMock).not.toHaveBeenCalled(); // never fanned out around 0,0
  });
});
