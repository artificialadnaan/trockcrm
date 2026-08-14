import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Field auth: inject an admin field user active in office A ("dallas").
vi.mock("../../../src/middleware/field-auth.js", () => ({
  requireFieldContractor: (req: any, _res: any, next: (err?: unknown) => void) => {
    req.fieldUser = { id: "user-1", role: "admin", tenantId: "id-dallas", firstName: "A", lastName: "U", email: "a@u.com" };
    next();
  },
}));

// Service layer mocked: we assert the ROUTES bind the resolved office, not the service internals.
const photoMocks = vi.hoisted(() => ({
  requestFieldPhotoUploadUrl: vi.fn(async () => ({ uploadUrl: "u", objectKey: "k", uploadToken: "t" })),
  confirmFieldPhotoUpload: vi.fn(async () => ({ photo: { id: "photo-1" } })),
  listPendingFieldPhotos: vi.fn(),
  assignPendingFieldPhotoTarget: vi.fn(async () => ({ photo: { id: "photo-1", dealId: "deal-b" } })),
  // Real-ish format validators: a no-op is enough (ids in these tests are well-formed-ish).
  assertValidCaptureTargetIds: vi.fn(),
  assertValidUuid: vi.fn(),
}));
vi.mock("../../../src/modules/field/photos-service.js", () => photoMocks);

const scorecardEvidenceMocks = vi.hoisted(() => ({
  assertScorecardEvidenceUploadAccess: vi.fn(async () => undefined),
  discardScorecardEditEvidence: vi.fn(async () => ({ discarded: 1 })),
}));
vi.mock("../../../src/modules/field/scorecard-evidence-upload.js", () => scorecardEvidenceMocks);

// File-targeted write services (tags / transcription) — mocked so we can assert the route resolves the
// PHOTO's office (via runFieldFileWrite → resolveWriteOffice("file", …)) and runs the edit there.
const tagMocks = vi.hoisted(() => ({
  replaceFieldPhotoTags: vi.fn(async () => ({ tags: ["roof"] })),
  deleteFieldPhotoTag: vi.fn(async () => ({ tags: [] })),
  searchFieldProjectTags: vi.fn(),
}));
vi.mock("../../../src/modules/field/photo-tags-service.js", () => tagMocks);

// Resolver + transaction helpers mocked so we can drive which office each id resolves to, pool-free.
// office A = dallas (the uploader's active office), office B = atlanta (the cross-office deal's home).
const xoMocks = vi.hoisted(() => ({
  enabled: false,
  // deal id "deal-b" / photo "photo-b" live in office B; everything else in office A.
  officeForId: (id: string) => (id.endsWith("-b") ? { id: "id-atlanta", slug: "atlanta" } : { id: "id-dallas", slug: "dallas" }),
  resolveWriteOffice: vi.fn(),
  runInOfficeTransaction: vi.fn(),
}));
vi.mock("../../../src/modules/field/cross-office.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../src/modules/field/cross-office.js")>();
  const officeDb = { execute: vi.fn() } as any;
  xoMocks.resolveWriteOffice.mockImplementation(async (_kind: string, id: string) => xoMocks.officeForId(id));
  xoMocks.runInOfficeTransaction.mockImplementation(async (_office: any, _userId: any, run: any) => run(officeDb, _office));
  return {
    ...actual,
    isFieldCrossOfficeWritesEnabled: vi.fn(() => xoMocks.enabled),
    getFieldOfficeById: vi.fn(async (id: string) => xoMocks.officeForId(id)),
    resolveWriteOffice: xoMocks.resolveWriteOffice,
    resolveFieldWriteOffice: vi.fn(async (uploaderId: string, target: any) =>
      xoMocks.enabled
        ? xoMocks.officeForId(target.dealId ?? target.opportunityId ?? target.leadId ?? uploaderId)
        : xoMocks.officeForId(uploaderId),
    ),
    runInOfficeTransaction: xoMocks.runInOfficeTransaction,
    runInOffice: vi.fn(async (_office: any, run: any) => run(officeDb, _office)),
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

beforeEach(() => {
  vi.clearAllMocks();
  xoMocks.enabled = false;
});
afterEach(() => {
  xoMocks.enabled = false;
});

describe("cross-office write re-binding (flag ON)", () => {
  it("upload-url binds the R2 key slug to the DEAL's office, not the uploader's", async () => {
    xoMocks.enabled = true;
    const res = await request(buildApp())
      .post("/api/field/photos/upload-url")
      .send({ dealId: "deal-b", contentType: "image/jpeg", sizeBytes: 100 });

    expect(res.status).toBe(200);
    // Uploader is active in office A (dallas), but the deal is in office B (atlanta) → slug must be atlanta.
    expect(photoMocks.requestFieldPhotoUploadUrl).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ officeSlug: "atlanta", dealId: "deal-b" }),
    );
  });

  it("confirm-upload binds job office id AND officeSlug to the DEAL's office", async () => {
    xoMocks.enabled = true;
    const res = await request(buildApp())
      .post("/api/field/photos/confirm-upload")
      .send({ dealId: "deal-b", uploadToken: "t", objectKey: "k" });

    expect(res.status).toBe(201);
    expect(photoMocks.confirmFieldPhotoUpload).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ officeId: "id-atlanta", officeSlug: "atlanta", dealId: "deal-b" }),
    );
  });

  it("assign-target REJECTS (409) a pending photo in office A being bound to a deal in office B", async () => {
    xoMocks.enabled = true;
    const res = await request(buildApp())
      .post("/api/field/photos/photo-a/assign-target") // photo-a → office A; deal-b → office B
      .send({ dealId: "deal-b" });

    expect(res.status).toBe(409);
    expect(res.body.error.message).toMatch(/can't be reassigned/i);
    expect(photoMocks.assignPendingFieldPhotoTarget).not.toHaveBeenCalled();
  });

  it("assign-target ALLOWS a same-office assignment (photo + deal both in office B)", async () => {
    xoMocks.enabled = true;
    const res = await request(buildApp())
      .post("/api/field/photos/photo-b/assign-target") // photo-b → office B; deal-b → office B
      .send({ dealId: "deal-b" });

    expect(res.status).toBe(200);
    expect(photoMocks.assignPendingFieldPhotoTarget).toHaveBeenCalledTimes(1);
  });

  it("tag write resolves the PHOTO's office (file-targeted) and runs the edit there", async () => {
    xoMocks.enabled = true;
    const res = await request(buildApp())
      .post("/api/field/photos/photo-b/tags") // photo-b → office B
      .send({ tags: ["roof"] });

    expect(res.status).toBe(200);
    expect(xoMocks.resolveWriteOffice).toHaveBeenCalledWith("file", "photo-b", expect.any(String));
    expect(tagMocks.replaceFieldPhotoTags).toHaveBeenCalledTimes(1);
  });

  it("tag delete resolves the PHOTO's office (file-targeted)", async () => {
    xoMocks.enabled = true;
    const res = await request(buildApp()).delete("/api/field/photos/photo-b/tags/roof");

    expect(res.status).toBe(200);
    expect(xoMocks.resolveWriteOffice).toHaveBeenCalledWith("file", "photo-b", expect.any(String));
    expect(tagMocks.deleteFieldPhotoTag).toHaveBeenCalledTimes(1);
  });
});

describe("write path is single-office when the flag is OFF (default — merge is inert)", () => {
  it("discard cleanup resolves by scorecard id and passes only the authenticated user's client ids", async () => {
    const res = await request(buildApp())
      .post("/api/field/scorecards/scorecard-b/discard-edit-evidence")
      .send({ clientUploadIds: ["cu-1", "cu-1"] });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ discarded: 1 });
    expect(xoMocks.resolveWriteOffice).toHaveBeenCalledWith("scorecard", "scorecard-b", "Scorecard not found");
    expect(scorecardEvidenceMocks.discardScorecardEditEvidence).toHaveBeenCalledWith(
      expect.anything(),
      { scorecardId: "scorecard-b", userId: "user-1", clientUploadIds: ["cu-1"] },
    );
  });

  it("rejects malformed discard ledgers before resolving an office", async () => {
    const res = await request(buildApp())
      .post("/api/field/scorecards/scorecard-b/discard-edit-evidence")
      .send({ clientUploadIds: [""] });

    expect(res.status).toBe(400);
    expect(scorecardEvidenceMocks.discardScorecardEditEvidence).not.toHaveBeenCalled();
  });

  it("upload-url resolves submitted-edit evidence by scorecard id without enabling generic cross-office writes", async () => {
    xoMocks.enabled = false;
    const res = await request(buildApp())
      .post("/api/field/photos/upload-url")
      .send({
        scorecardId: "scorecard-b",
        clientUploadId: "cu-scorecard-1",
        dealId: "deal-b",
        contentType: "image/jpeg",
        sizeBytes: 100,
        tags: ["safety"],
      });

    expect(res.status).toBe(200);
    expect(xoMocks.resolveWriteOffice).toHaveBeenCalledWith("scorecard", "scorecard-b", "Scorecard not found");
    expect(scorecardEvidenceMocks.assertScorecardEvidenceUploadAccess).toHaveBeenCalledWith(
      expect.anything(),
      { scorecardId: "scorecard-b", userId: "user-1", target: { dealId: "deal-b" } },
    );
    expect(photoMocks.requestFieldPhotoUploadUrl).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        officeSlug: "atlanta",
        dealId: "deal-b",
        scorecardId: "scorecard-b",
        clientUploadId: "cu-scorecard-1",
        tags: ["safety"],
      }),
    );
  });

  it("requires an exact client upload id before authorizing submitted-edit evidence", async () => {
    const res = await request(buildApp())
      .post("/api/field/photos/upload-url")
      .send({ scorecardId: "scorecard-b", dealId: "deal-b", contentType: "image/jpeg", sizeBytes: 100 });

    expect(res.status).toBe(400);
    expect(scorecardEvidenceMocks.assertScorecardEvidenceUploadAccess).not.toHaveBeenCalled();
    expect(photoMocks.requestFieldPhotoUploadUrl).not.toHaveBeenCalled();
  });

  it("confirm-upload re-authorizes and resolves submitted-edit evidence by scorecard id", async () => {
    xoMocks.enabled = false;
    const res = await request(buildApp())
      .post("/api/field/photos/confirm-upload")
      .send({
        scorecardId: "scorecard-b",
        clientUploadId: "cu-scorecard-1",
        dealId: "deal-b",
        uploadToken: "t",
        objectKey: "k",
      });

    expect(res.status).toBe(201);
    expect(scorecardEvidenceMocks.assertScorecardEvidenceUploadAccess).toHaveBeenCalledWith(
      expect.anything(),
      { scorecardId: "scorecard-b", userId: "user-1", target: { dealId: "deal-b" } },
    );
    expect(photoMocks.confirmFieldPhotoUpload).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        officeId: "id-atlanta",
        officeSlug: "atlanta",
        dealId: "deal-b",
        scorecardId: "scorecard-b",
        clientUploadId: "cu-scorecard-1",
      }),
    );
  });

  it("upload-url binds the UPLOADER's office even with a cross-office deal target", async () => {
    xoMocks.enabled = false;
    const res = await request(buildApp())
      .post("/api/field/photos/upload-url")
      .send({ dealId: "deal-b", contentType: "image/jpeg", sizeBytes: 100 });

    expect(res.status).toBe(200);
    // Flag off → uploader's office (dallas), today's behavior, regardless of the deal's true office.
    expect(photoMocks.requestFieldPhotoUploadUrl).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ officeSlug: "dallas" }),
    );
    expect(scorecardEvidenceMocks.assertScorecardEvidenceUploadAccess).not.toHaveBeenCalled();
  });

  it("confirm-upload remains in the UPLOADER's office when no scorecard scope is supplied", async () => {
    xoMocks.enabled = false;
    const res = await request(buildApp())
      .post("/api/field/photos/confirm-upload")
      .send({ dealId: "deal-b", uploadToken: "t", objectKey: "k" });

    expect(res.status).toBe(201);
    expect(photoMocks.confirmFieldPhotoUpload).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ officeId: "id-dallas", officeSlug: "dallas", dealId: "deal-b" }),
    );
    expect(scorecardEvidenceMocks.assertScorecardEvidenceUploadAccess).not.toHaveBeenCalled();
  });

  it("assign-target does NOT 409 cross-office when the flag is off (no cross-office resolution at all)", async () => {
    xoMocks.enabled = false;
    const res = await request(buildApp())
      .post("/api/field/photos/photo-a/assign-target")
      .send({ dealId: "deal-b" });

    expect(res.status).toBe(200);
    expect(photoMocks.assignPendingFieldPhotoTarget).toHaveBeenCalledTimes(1);
  });
});
