import request from "supertest";
import express from "express";
import { beforeEach, describe, expect, it, vi } from "vitest";

const generatePublicTokenMock = vi.hoisted(() => vi.fn());
const assertPhotosBelongToDealMock = vi.hoisted(() => vi.fn());
const withResolvedOfficeMock = vi.hoisted(() => vi.fn());

// Field auth: authenticate as a field contractor (no real token needed).
vi.mock("../src/middleware/field-auth.js", () => ({
  requireFieldContractor: (req: any, _res: any, next: () => void) => {
    req.fieldUser = { id: "field-user-1", role: "field_contractor", tenantId: "office-home" };
    next();
  },
  requireCrmUser: (_req: any, _res: any, next: () => void) => next(),
}));

// The public-share service is exercised by its own unit tests; here we assert the route wiring.
vi.mock("../src/modules/public-photo-tokens/service.js", () => ({
  generatePublicToken: generatePublicTokenMock,
  assertPhotosBelongToDeal: assertPhotosBelongToDealMock,
}));

// Stub the cross-office resolver (and the other exports the field router imports).
vi.mock("../src/modules/field/cross-office.js", () => ({
  withResolvedOffice: withResolvedOfficeMock,
  assertFanOutNotFullyDegraded: vi.fn(),
  fanOutActiveOffices: vi.fn(),
  getFieldOfficeById: vi.fn(),
  isFieldCrossOfficeWritesEnabled: vi.fn(() => false),
  officeTag: vi.fn(),
  resolveFieldWriteOffice: vi.fn(),
  resolveWriteOffice: vi.fn(),
  runInOffice: vi.fn(),
  runInOfficeTransaction: vi.fn(),
}));

const { fieldRoutes } = await import("../src/modules/field/routes.js");

const VALID_DEAL = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const PHOTO_A = "11111111-1111-1111-1111-111111111111";

// A field-visible project row (assertActiveFieldProject is the REAL function and runs first).
const FIELD_VISIBLE_DEAL = {
  rows: [{
    id: VALID_DEAL, name: "Deal", deal_number: "TR-1", property_name: "Deal",
    property_address: "100 Main St", stage_name: "Won",
    last_activity_at: "2026-06-01T00:00:00.000Z", photo_count: 0, starred: false,
  }],
};

// Drive withResolvedOffice: resolve the Dallas office and run the callback against an officeDb whose
// `execute` (used by the real assertActiveFieldProject) returns the given rows.
function resolveOfficeRunning(executeResult: unknown) {
  return async (_kind: string, _id: string, run: (db: any, office: any) => Promise<unknown>) => {
    const office = { id: "office-dallas", slug: "dallas" };
    const value = await run({ execute: vi.fn().mockResolvedValue(executeResult) }, office);
    return { value, office };
  };
}

function createApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/field", fieldRoutes);
  app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(err.statusCode ?? 500).json({ error: { message: err.message } });
  });
  return app;
}

const err = (status: number, message: string) => Object.assign(new Error(message), { statusCode: status });

beforeEach(() => {
  generatePublicTokenMock.mockReset();
  assertPhotosBelongToDealMock.mockReset().mockResolvedValue(undefined);
  withResolvedOfficeMock.mockReset();
});

describe("POST /api/field/projects/:dealId/share", () => {
  it("mints a 90-day, photos-only subset share link for a field-visible project", async () => {
    withResolvedOfficeMock.mockImplementation(resolveOfficeRunning(FIELD_VISIBLE_DEAL));
    generatePublicTokenMock.mockResolvedValue({ rawToken: "RAW-TOKEN", token: { id: "token-1", expiresAt: "2026-06-19T00:00:00.000Z" } });

    const res = await request(createApp()).post(`/api/field/projects/${VALID_DEAL}/share`).send({ photoIds: [PHOTO_A] });

    expect(res.status).toBe(201);
    expect(res.body.photoCount).toBe(1);
    expect(res.body.token).toEqual({ id: "token-1", expiresAt: "2026-06-19T00:00:00.000Z" });
    expect(res.body.url).toContain("/p/RAW-TOKEN");
    expect(generatePublicTokenMock).toHaveBeenCalledWith(
      expect.objectContaining({
        dealId: VALID_DEAL,
        tenantId: "office-dallas",
        createdByUserId: "field-user-1",
        photoIds: [PHOTO_A],
        expiresAt: expect.any(Date),
      }),
    );
    expect(assertPhotosBelongToDealMock).toHaveBeenCalledWith(expect.anything(), VALID_DEAL, [PHOTO_A]);
    const { expiresAt } = generatePublicTokenMock.mock.calls[0][0];
    const ttlMs = (expiresAt as Date).getTime() - Date.now();
    expect(ttlMs).toBeGreaterThan(89.9 * 24 * 3600 * 1000);
    expect(ttlMs).toBeLessThanOrEqual(90 * 24 * 3600 * 1000);
  });

  it("canonicalizes uppercase photo UUIDs to lowercase before validating/minting", async () => {
    withResolvedOfficeMock.mockImplementation(resolveOfficeRunning(FIELD_VISIBLE_DEAL));
    generatePublicTokenMock.mockResolvedValue({ rawToken: "RAW-TOKEN", token: { id: "token-1", expiresAt: "2026-06-19T00:00:00.000Z" } });

    const res = await request(createApp())
      .post(`/api/field/projects/${VALID_DEAL}/share`)
      .send({ photoIds: [PHOTO_A.toUpperCase()] });

    expect(res.status).toBe(201);
    // Stored + validated as canonical lowercase (matches Postgres), not the uppercase the client sent.
    expect(assertPhotosBelongToDealMock).toHaveBeenCalledWith(expect.anything(), VALID_DEAL, [PHOTO_A]);
    expect(generatePublicTokenMock).toHaveBeenCalledWith(expect.objectContaining({ photoIds: [PHOTO_A] }));
  });

  it("rejects an empty photoIds list (400) before resolving anything", async () => {
    const res = await request(createApp()).post(`/api/field/projects/${VALID_DEAL}/share`).send({ photoIds: [] });
    expect(res.status).toBe(400);
    expect(withResolvedOfficeMock).not.toHaveBeenCalled();
    expect(generatePublicTokenMock).not.toHaveBeenCalled();
  });

  it("rejects a non-uuid photoId (400)", async () => {
    const res = await request(createApp()).post(`/api/field/projects/${VALID_DEAL}/share`).send({ photoIds: ["not-a-uuid"] });
    expect(res.status).toBe(400);
    expect(withResolvedOfficeMock).not.toHaveBeenCalled();
  });

  it("rejects a non-uuid dealId (400)", async () => {
    const res = await request(createApp()).post("/api/field/projects/bad-deal/share").send({ photoIds: [PHOTO_A] });
    expect(res.status).toBe(400);
    expect(withResolvedOfficeMock).not.toHaveBeenCalled();
  });

  it("404s when the deal is not found in any active office", async () => {
    withResolvedOfficeMock.mockRejectedValue(err(404, "Project not found"));
    const res = await request(createApp()).post(`/api/field/projects/${VALID_DEAL}/share`).send({ photoIds: [PHOTO_A] });
    expect(res.status).toBe(404);
    expect(generatePublicTokenMock).not.toHaveBeenCalled();
  });

  it("404s (no token) when the deal is not a field-visible project (Lost / archived)", async () => {
    // The deal resolves to an office, but assertActiveFieldProject finds no field-visible row.
    withResolvedOfficeMock.mockImplementation(resolveOfficeRunning({ rows: [] }));
    const res = await request(createApp()).post(`/api/field/projects/${VALID_DEAL}/share`).send({ photoIds: [PHOTO_A] });
    expect(res.status).toBe(404);
    expect(assertPhotosBelongToDealMock).not.toHaveBeenCalled();
    expect(generatePublicTokenMock).not.toHaveBeenCalled();
  });

  it("400s (and mints no token) when a selected photo is not part of the project", async () => {
    withResolvedOfficeMock.mockImplementation(resolveOfficeRunning(FIELD_VISIBLE_DEAL));
    assertPhotosBelongToDealMock.mockRejectedValue(err(400, "One or more selected photos are not part of this project."));

    const res = await request(createApp()).post(`/api/field/projects/${VALID_DEAL}/share`).send({ photoIds: [PHOTO_A] });
    expect(res.status).toBe(400);
    expect(generatePublicTokenMock).not.toHaveBeenCalled();
  });
});
