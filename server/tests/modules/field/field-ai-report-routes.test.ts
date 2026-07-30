import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Route-level contract for the async AI report: POST /reports/ai-generate (enqueue) and
 * GET /reports/ai-status/:runId (poll). Follows the field-cross-office-write-routes harness — field auth
 * and the service layer are mocked so these assert what the ROUTES do, pool-free.
 */

vi.mock("../../../src/middleware/field-auth.js", () => ({
  requireFieldContractor: (req: any, _res: any, next: (err?: unknown) => void) => {
    req.fieldUser = { id: "user-1", role: "admin", tenantId: "id-dallas", firstName: "A", lastName: "U", email: "a@u.com" };
    next();
  },
}));

const photoMocks = vi.hoisted(() => ({
  assertValidCaptureTargetIds: vi.fn(),
  assertValidUuid: vi.fn(),
  requestFieldPhotoUploadUrl: vi.fn(),
  confirmFieldPhotoUpload: vi.fn(),
  listPendingFieldPhotos: vi.fn(),
  assignPendingFieldPhotoTarget: vi.fn(),
}));
vi.mock("../../../src/modules/field/photos-service.js", () => photoMocks);

const aiMocks = vi.hoisted(() => ({
  isAiReportConfigured: vi.fn(() => true),
  // Must mirror the REAL constant: the route slices the focus prompt with it, and a mock that omitted it
  // would silently disable the cap under test.
  MAX_FOCUS_PROMPT_LENGTH: 1_000,
}));
vi.mock("../../../src/modules/field/ai-report-service.js", () => aiMocks);

const runMocks = vi.hoisted(() => ({
  AI_REPORT_JOB_TYPE: "ai_report_generation",
  insertAiReportRunTx: vi.fn(async () => ({ id: "run-1", status: "queued" })),
  getAiReportRun: vi.fn(),
  getInFlightAiReportRun: vi.fn(),
  expireStaleAiReportRuns: vi.fn(async () => 0),
  // Real predicate, not a stub that always agrees — a mock that returned true for everything would make
  // the conflict path swallow unrelated database errors and the test would never notice.
  isInFlightRunConflict: (error: unknown) =>
    (error as { code?: string })?.code === "23505" &&
    String((error as { constraint?: string })?.constraint ?? "").includes("field_ai_report_runs_inflight"),
}));
vi.mock("../../../src/modules/field/ai-report-runs.js", () => runMocks);

const projectMocks = vi.hoisted(() => ({
  assertActiveFieldProject: vi.fn(async (_db: any, _access: any, id: string) => ({ id, name: "Tides at Park Lane", dealNumber: "D-1" })),
}));
vi.mock("../../../src/modules/field/projects-service.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../src/modules/field/projects-service.js")>()),
  ...projectMocks,
}));

const reportMocks = vi.hoisted(() => ({
  getFieldProjectReportDetail: vi.fn(async () => ({
    report: { id: "file-1", title: "Tides Condition Assessment", pdfUrl: "https://r2/signed.pdf", expiresAt: null, createdAt: "2026-07-30T00:00:00.000Z" },
  })),
}));
vi.mock("../../../src/modules/field/photo-reports-service.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../src/modules/field/photo-reports-service.js")>()),
  ...reportMocks,
}));

// Captures every statement the route runs on the transaction's handle, so we can prove the run row and the
// job_queue row are enqueued on the SAME connection (and therefore commit or roll back together).
const officeDb = vi.hoisted(() => ({ execute: vi.fn(async () => ({ rows: [] })) }));
const xoMocks = vi.hoisted(() => ({ runInOfficeTransaction: vi.fn(), runInOffice: vi.fn() }));
vi.mock("../../../src/modules/field/cross-office.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../src/modules/field/cross-office.js")>();
  xoMocks.runInOfficeTransaction.mockImplementation(async (office: any, _userId: any, run: any) => run(officeDb, office));
  xoMocks.runInOffice.mockImplementation(async (office: any, run: any) => run(officeDb, office));
  return {
    ...actual,
    isFieldCrossOfficeWritesEnabled: vi.fn(() => false),
    getFieldOfficeById: vi.fn(async (id: string) => ({ id, slug: id === "id-atlanta" ? "atlanta" : "dallas" })),
    resolveFieldWriteOffice: vi.fn(async () => ({ id: "id-dallas", slug: "dallas" })),
    runInOfficeTransaction: xoMocks.runInOfficeTransaction,
    runInOffice: xoMocks.runInOffice,
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

const PHOTO_A = "aaaaaaaa-1111-1111-1111-111111111111";
const PHOTO_B = "bbbbbbbb-2222-2222-2222-222222222222";
const PROJECT = "cccccccc-3333-3333-3333-333333333333";

beforeEach(() => {
  vi.clearAllMocks();
  aiMocks.isAiReportConfigured.mockReturnValue(true);
  runMocks.insertAiReportRunTx.mockResolvedValue({ id: "run-1", status: "queued" } as any);
  officeDb.execute.mockResolvedValue({ rows: [] } as any);
  projectMocks.assertActiveFieldProject.mockImplementation(async (_db: any, _access: any, id: string) => ({ id, name: "Tides at Park Lane", dealNumber: "D-1" }) as any);
});

describe("POST /field/reports/ai-generate", () => {
  it("queues a run and returns 202 without waiting on the model", async () => {
    const res = await request(buildApp())
      .post("/api/field/reports/ai-generate")
      .send({ projectId: PROJECT, photoIds: [PHOTO_A, PHOTO_B] });

    expect(res.status).toBe(202);
    expect(res.body).toEqual({ runId: "run-1", status: "queued" });
  });

  it("enqueues the job on the SAME transaction handle that inserted the run row", async () => {
    // If these split across connections, a rollback could leave a 'queued' run no worker will ever claim —
    // the phone would then poll it until it timed out.
    await request(buildApp())
      .post("/api/field/reports/ai-generate")
      .send({ projectId: PROJECT, photoIds: [PHOTO_A] });

    expect(runMocks.insertAiReportRunTx).toHaveBeenCalledWith(officeDb, expect.objectContaining({ dealId: PROJECT }));
    expect(officeDb.execute).toHaveBeenCalledTimes(1);
    const enqueued = JSON.stringify(officeDb.execute.mock.calls[0][0]);
    expect(enqueued).toContain("public.job_queue");
    expect(enqueued).toContain("ai_report_generation");
    expect(enqueued).toContain("run-1");
  });

  it("records the selection in print order, de-duplicated", async () => {
    await request(buildApp())
      .post("/api/field/reports/ai-generate")
      .send({ projectId: PROJECT, photoIds: [PHOTO_B, PHOTO_A, PHOTO_B] });

    // Order is the print order AND the order the model sees the photographs in — a re-sort mis-captions
    // every page, so the dedupe must preserve first-seen position.
    expect(runMocks.insertAiReportRunTx).toHaveBeenCalledWith(
      officeDb,
      expect.objectContaining({ photoIds: [PHOTO_B, PHOTO_A] }),
    );
  });

  it("records the focus prompt on the run so the worker can scope the assessment", async () => {
    await request(buildApp())
      .post("/api/field/reports/ai-generate")
      .send({ projectId: PROJECT, photoIds: [PHOTO_A], focusPrompt: "  Roof drainage only  " });

    expect(runMocks.insertAiReportRunTx).toHaveBeenCalledWith(
      officeDb,
      expect.objectContaining({ focusPrompt: "Roof drainage only" }),
    );
  });

  it("stores a blank focus as null — that is the general-assessment case, not an error", async () => {
    await request(buildApp())
      .post("/api/field/reports/ai-generate")
      .send({ projectId: PROJECT, photoIds: [PHOTO_A], focusPrompt: "   " });

    expect(runMocks.insertAiReportRunTx).toHaveBeenCalledWith(
      officeDb,
      expect.objectContaining({ focusPrompt: null }),
    );
  });

  it("caps a pathological focus prompt instead of forwarding it to the model", async () => {
    await request(buildApp())
      .post("/api/field/reports/ai-generate")
      .send({ projectId: PROJECT, photoIds: [PHOTO_A], focusPrompt: "x".repeat(5_000) });

    const stored = runMocks.insertAiReportRunTx.mock.calls[0][1] as unknown as { focusPrompt: string };
    expect(stored.focusPrompt).toHaveLength(1_000);
  });

  it("clears an abandoned run before enqueueing so the in-flight guard cannot lock a user out", async () => {
    // Without this the unique index is a permanent lockout: a run orphaned by a dead worker holds the
    // (deal, requester) slot forever and every later attempt collides with a run that will never finish.
    await request(buildApp())
      .post("/api/field/reports/ai-generate")
      .send({ projectId: PROJECT, photoIds: [PHOTO_A] });

    expect(runMocks.expireStaleAiReportRuns).toHaveBeenCalledWith(PROJECT, "user-1");
    // ...and it runs BEFORE the insert, or it would be reaping a slot the insert already lost.
    const expireOrder = runMocks.expireStaleAiReportRuns.mock.invocationCallOrder[0];
    const insertOrder = runMocks.insertAiReportRunTx.mock.invocationCallOrder[0];
    expect(expireOrder).toBeLessThan(insertOrder);
  });

  it("hands a double-tap the run already in flight instead of buying a second Claude pass", async () => {
    const conflict = Object.assign(new Error("duplicate key"), {
      code: "23505",
      constraint: "field_ai_report_runs_inflight_uidx",
    });
    runMocks.insertAiReportRunTx.mockRejectedValueOnce(conflict as never);
    runMocks.getInFlightAiReportRun.mockResolvedValue({
      id: "run-existing",
      status: "running",
      photoIds: [PHOTO_A],
      focusPrompt: null,
    } as never);

    const res = await request(buildApp())
      .post("/api/field/reports/ai-generate")
      .send({ projectId: PROJECT, photoIds: [PHOTO_A] });

    // Not an error the user should ever see — the phone just polls the run that won the race.
    expect(res.status).toBe(202);
    expect(res.body).toEqual({ runId: "run-existing", status: "running" });
  });

  it("refuses to serve the in-flight run when the request asks a DIFFERENT question", async () => {
    // The unique index keys on (deal, requester) alone, so changing the focus and tapping again collides
    // too. Handing back the first run would open the earlier PDF as though it answered the new question —
    // silently serving the wrong report is far worse than making the user wait.
    const conflict = Object.assign(new Error("duplicate key"), {
      code: "23505",
      constraint: "field_ai_report_runs_inflight_uidx",
    });
    runMocks.insertAiReportRunTx.mockRejectedValueOnce(conflict as never);
    runMocks.getInFlightAiReportRun.mockResolvedValue({
      id: "run-existing",
      status: "running",
      photoIds: [PHOTO_A],
      focusPrompt: "roof drainage only",
    } as never);

    const res = await request(buildApp())
      .post("/api/field/reports/ai-generate")
      .send({ projectId: PROJECT, photoIds: [PHOTO_A], focusPrompt: "structural framing" });

    expect(res.status).toBe(409);
    expect(res.body.error.message).toMatch(/different AI report is still being generated/i);
  });

  it("also refuses when only the photo selection changed", async () => {
    const conflict = Object.assign(new Error("duplicate key"), {
      code: "23505",
      constraint: "field_ai_report_runs_inflight_uidx",
    });
    runMocks.insertAiReportRunTx.mockRejectedValueOnce(conflict as never);
    runMocks.getInFlightAiReportRun.mockResolvedValue({
      id: "run-existing",
      status: "running",
      photoIds: [PHOTO_A],
      focusPrompt: null,
    } as never);

    const res = await request(buildApp())
      .post("/api/field/reports/ai-generate")
      .send({ projectId: PROJECT, photoIds: [PHOTO_A, PHOTO_B] });

    expect(res.status).toBe(409);
  });

  it("does not swallow an unrelated database error as a double-tap", async () => {
    const unrelated = Object.assign(new Error("deadlock detected"), { code: "40P01" });
    runMocks.insertAiReportRunTx.mockRejectedValueOnce(unrelated as never);

    const res = await request(buildApp())
      .post("/api/field/reports/ai-generate")
      .send({ projectId: PROJECT, photoIds: [PHOTO_A] });

    expect(res.status).toBe(500);
    expect(runMocks.getInFlightAiReportRun).not.toHaveBeenCalled();
  });

  it("surfaces the original conflict when the in-flight run finished in the gap", async () => {
    const conflict = Object.assign(new Error("duplicate key"), {
      code: "23505",
      constraint: "field_ai_report_runs_inflight_uidx",
    });
    runMocks.insertAiReportRunTx.mockRejectedValueOnce(conflict as never);
    runMocks.getInFlightAiReportRun.mockResolvedValue(null as never);

    const res = await request(buildApp())
      .post("/api/field/reports/ai-generate")
      .send({ projectId: PROJECT, photoIds: [PHOTO_A] });

    expect(res.status).toBe(500);
  });

  it("rejects an empty selection", async () => {
    const res = await request(buildApp()).post("/api/field/reports/ai-generate").send({ projectId: PROJECT, photoIds: [] });
    expect(res.status).toBe(400);
    expect(runMocks.insertAiReportRunTx).not.toHaveBeenCalled();
  });

  it("rejects a selection beyond the per-report cap", async () => {
    const many = Array.from({ length: 61 }, (_, i) => `${String(i).padStart(8, "0")}-1111-1111-1111-111111111111`);
    const res = await request(buildApp()).post("/api/field/reports/ai-generate").send({ projectId: PROJECT, photoIds: many });
    expect(res.status).toBe(400);
    expect(res.body.error.message).toMatch(/at most 60/);
    expect(runMocks.insertAiReportRunTx).not.toHaveBeenCalled();
  });

  it("returns 503 when no model key is configured instead of queueing an unrunnable job", async () => {
    aiMocks.isAiReportConfigured.mockReturnValue(false);
    const res = await request(buildApp())
      .post("/api/field/reports/ai-generate")
      .send({ projectId: PROJECT, photoIds: [PHOTO_A] });
    expect(res.status).toBe(503);
    expect(runMocks.insertAiReportRunTx).not.toHaveBeenCalled();
  });
});

describe("GET /field/reports/ai-status/:runId", () => {
  const RUN = "dddddddd-4444-4444-4444-444444444444";

  it("reports a still-running run with no report payload", async () => {
    runMocks.getAiReportRun.mockResolvedValue({ id: RUN, requestedBy: "user-1", status: "running", fileId: null, error: null, officeId: "id-dallas" } as any);
    const res = await request(buildApp()).get(`/api/field/reports/ai-status/${RUN}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ runId: RUN, status: "running" });
  });

  it("returns the failure reason so the app can show it instead of hanging", async () => {
    runMocks.getAiReportRun.mockResolvedValue({ id: RUN, requestedBy: "user-1", status: "failed", fileId: null, error: "Claude request timed out.", officeId: "id-dallas" } as any);
    const res = await request(buildApp()).get(`/api/field/reports/ai-status/${RUN}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ runId: RUN, status: "failed", error: "Claude request timed out." });
  });

  it("returns the same report shape the synchronous generate endpoint does", async () => {
    runMocks.getAiReportRun.mockResolvedValue({ id: RUN, requestedBy: "user-1", status: "succeeded", fileId: "file-1", error: null, officeId: "id-atlanta" } as any);
    const res = await request(buildApp()).get(`/api/field/reports/ai-status/${RUN}`);
    expect(res.status).toBe(200);
    expect(res.body.report).toMatchObject({ id: "file-1", pdfUrl: "https://r2/signed.pdf" });
    // Bound to the office the RUN recorded, not the caller's active office.
    expect(xoMocks.runInOffice).toHaveBeenCalledWith(expect.objectContaining({ slug: "atlanta" }), expect.anything());
  });

  it("404s another user's run rather than confirming it exists", async () => {
    runMocks.getAiReportRun.mockResolvedValue({ id: RUN, requestedBy: "someone-else", status: "succeeded", fileId: "file-1", error: null, officeId: "id-dallas" } as any);
    const res = await request(buildApp()).get(`/api/field/reports/ai-status/${RUN}`);
    expect(res.status).toBe(404);
    expect(reportMocks.getFieldProjectReportDetail).not.toHaveBeenCalled();
  });

  it("404s an unknown run", async () => {
    runMocks.getAiReportRun.mockResolvedValue(null as any);
    const res = await request(buildApp()).get(`/api/field/reports/ai-status/${RUN}`);
    expect(res.status).toBe(404);
  });
});
