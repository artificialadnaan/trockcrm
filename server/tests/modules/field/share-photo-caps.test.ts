import request from "supertest";
import express from "express";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The share cap and the bulk-download cap USED TO BE ONE CONSTANT, applied by one parser to both
 * routes. Raising it for /share would therefore have silently raised it for /photos/download-urls too —
 * a route that presigns and audits every requested photo inside a single transaction-bound client and
 * then asks the browser to start that many downloads at once.
 *
 * These tests exist to prove the two caps are INDEPENDENT, so a future raise of one cannot leak into
 * the other by accident. They deliberately assert the boundary from both sides (N accepted, N+1
 * rejected) rather than just the rejection.
 */

const generatePublicTokenMock = vi.hoisted(() => vi.fn());
const assertPhotosBelongToDealMock = vi.hoisted(() => vi.fn());
const withResolvedOfficeMock = vi.hoisted(() => vi.fn());
// /reports/* routes go through runFieldDealWrite -> resolveFieldWriteOffice, NOT withResolvedOffice.
const resolveFieldWriteOfficeMock = vi.hoisted(() => vi.fn());

vi.mock("../../../src/middleware/field-auth.js", () => ({
  requireFieldContractor: (req: any, _res: any, next: () => void) => {
    req.fieldUser = { id: "field-user-1", role: "field_contractor", tenantId: "office-home" };
    next();
  },
  requireCrmUser: (_req: any, _res: any, next: () => void) => next(),
}));

vi.mock("../../../src/modules/public-photo-tokens/service.js", () => ({
  generatePublicToken: generatePublicTokenMock,
  assertPhotosBelongToDeal: assertPhotosBelongToDealMock,
}));

vi.mock("../../../src/modules/field/cross-office.js", () => ({
  withResolvedOffice: withResolvedOfficeMock,
  assertFanOutNotFullyDegraded: vi.fn(),
  fanOutActiveOffices: vi.fn(),
  getFieldOfficeById: vi.fn(),
  isFieldCrossOfficeWritesEnabled: vi.fn(() => false),
  officeTag: vi.fn(() => ({})),
  resolveFieldWriteOffice: resolveFieldWriteOfficeMock,
  resolveWriteOffice: vi.fn(),
  runInOffice: vi.fn(),
  runInOfficeTransaction: vi.fn(),
}));

const { fieldRoutes } = await import("../../../src/modules/field/routes.js");

const VALID_DEAL = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";

// A field-visible project row (assertActiveFieldProject is the REAL function and runs first).
const FIELD_VISIBLE_DEAL = {
  rows: [{
    id: VALID_DEAL, name: "Deal", deal_number: "TR-1", property_name: "Deal",
    property_address: "100 Main St", stage_name: "Won",
    last_activity_at: "2026-06-01T00:00:00.000Z", photo_count: 0, starred: false,
  }],
};

// Distinct, canonical-lowercase uuids. The parser de-duplicates, so the cap must be measured against
// UNIQUE ids — a test that repeated one id would pass trivially at any cap.
function photoIds(count: number): string[] {
  return Array.from({ length: count }, (_, i) => `11111111-1111-1111-1111-${String(i).padStart(12, "0")}`);
}

function createApp() {
  const app = express();
  // A 3000-id share body is ~111KB of JSON, over express.json's 100KB DEFAULT. The real app already
  // mounts `express.json({ limit: "10mb" })` (src/app.ts), so production has the headroom; this test
  // app has to opt in explicitly or it would 413 before the route ever saw the request.
  app.use(express.json({ limit: "10mb" }));
  app.use("/api/field", fieldRoutes);
  app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(err.statusCode ?? 500).json({ error: { message: err.message } });
  });
  return app;
}

function resolveOfficeRunning(executeResult: unknown, value?: unknown) {
  return async (_kind: string, _id: string, run: (db: any, office: any) => Promise<unknown>) => {
    const office = { id: "office-dallas", slug: "dallas" };
    const ran = await run({ execute: vi.fn().mockResolvedValue(executeResult) }, office);
    return { value: value ?? ran, office };
  };
}

beforeEach(() => {
  generatePublicTokenMock.mockReset().mockResolvedValue({
    rawToken: "RAW-TOKEN",
    token: { id: "token-1", expiresAt: "2026-10-19T00:00:00.000Z" },
  });
  assertPhotosBelongToDealMock.mockReset().mockResolvedValue(undefined);
  withResolvedOfficeMock.mockReset();
  resolveFieldWriteOfficeMock.mockReset().mockResolvedValue({ id: "office-dallas", slug: "dallas" });
});

describe("share link photo cap", () => {
  it("accepts a selection at the cap (3000)", async () => {
    withResolvedOfficeMock.mockImplementation(resolveOfficeRunning(FIELD_VISIBLE_DEAL));

    const res = await request(createApp())
      .post(`/api/field/projects/${VALID_DEAL}/share`)
      .send({ photoIds: photoIds(3000) });

    expect(res.status).toBe(201);
    expect(res.body.photoCount).toBe(3000);
    expect(generatePublicTokenMock).toHaveBeenCalledWith(
      expect.objectContaining({ photoIds: expect.arrayContaining([photoIds(1)[0]]) }),
    );
  });

  it("rejects one photo over the cap, before resolving the office or minting anything", async () => {
    const res = await request(createApp())
      .post(`/api/field/projects/${VALID_DEAL}/share`)
      .send({ photoIds: photoIds(3001) });

    expect(res.status).toBe(400);
    expect(res.body.error.message).toContain("at most 3000 photos");
    // Rejected at parse time — no office resolution, no membership query, no token row.
    expect(withResolvedOfficeMock).not.toHaveBeenCalled();
    expect(assertPhotosBelongToDealMock).not.toHaveBeenCalled();
    expect(generatePublicTokenMock).not.toHaveBeenCalled();
  });
});

describe("bulk download photo cap (independent of the share cap)", () => {
  it("rejects a selection the SHARE route would have accepted", async () => {
    // 201 ids: comfortably under the 3000 share cap, one over the download cap. This is the assertion
    // that would fail the instant the two routes went back to sharing a constant.
    const res = await request(createApp())
      .post(`/api/field/projects/${VALID_DEAL}/photos/download-urls`)
      .send({ photoIds: photoIds(201) });

    expect(res.status).toBe(400);
    expect(res.body.error.message).toContain("at most 200 photos");
    expect(withResolvedOfficeMock).not.toHaveBeenCalled();
  });

  it("accepts a selection at its own cap (200)", async () => {
    withResolvedOfficeMock.mockImplementation(resolveOfficeRunning(FIELD_VISIBLE_DEAL, []));

    const res = await request(createApp())
      .post(`/api/field/projects/${VALID_DEAL}/photos/download-urls`)
      .send({ photoIds: photoIds(200) });

    // The cap is enforced at parse time, before the office is resolved. Reaching the resolver is
    // therefore the precise signal that exactly-at-the-cap was accepted — the rest of the download
    // pipeline is covered by photo-download-urls.test.ts and is not what this file is asserting.
    // NOT a 400 (the only status the cap itself produces) AND the office resolver was reached — those
    // two together are the precise signal that exactly-at-the-cap parsed. The download pipeline beyond
    // this point is unmocked here and covered by photo-download-urls.test.ts.
    expect(res.status).not.toBe(400);
    expect(withResolvedOfficeMock).toHaveBeenCalled();
  });
});

describe("photo report budget", () => {
  it("rejects a report selection over the cap before any PDF work starts", async () => {
    const res = await request(createApp())
      .post("/api/field/reports/preview")
      .send({ projectId: VALID_DEAL, photoIds: photoIds(501) });

    expect(res.status).toBe(400);
    expect(res.body.error.message).toContain("at most 500 photos");
    // Rejected before any office resolution, so no R2 fetch or PDF render is ever started.
    expect(resolveFieldWriteOfficeMock).not.toHaveBeenCalled();
  });

  it("counts report photos across ALL sections, since the renderer walks them in one pass", async () => {
    const ids = photoIds(600);
    const res = await request(createApp())
      .post("/api/field/reports/generate")
      .send({
        projectId: VALID_DEAL,
        sections: [{ title: "A", photoIds: ids.slice(0, 300) }, { title: "B", photoIds: ids.slice(300) }],
      });

    // Neither section exceeds the cap on its own; their union does.
    expect(res.status).toBe(400);
    expect(res.body.error.message).toContain("Selected: 600");
  });

  it("counts the union, so the same photo reused across sections is not double-charged", async () => {
    withResolvedOfficeMock.mockImplementation(resolveOfficeRunning(FIELD_VISIBLE_DEAL, { id: "report-1" }));
    const ids = photoIds(400);
    const res = await request(createApp())
      .post("/api/field/reports/generate")
      .send({
        projectId: VALID_DEAL,
        sections: [{ title: "A", photoIds: ids }, { title: "B", photoIds: ids }],
      });

    // 400 distinct photos across two sections is under the cap, so the budget must let it through to
    // the renderer rather than charging the same id twice. Reaching the office resolver is the precise
    // signal; a status-only assertion would also pass if the budget rejected it for another reason.
    expect(res.status).not.toBe(400);
    expect(resolveFieldWriteOfficeMock).toHaveBeenCalled();
  });
});
