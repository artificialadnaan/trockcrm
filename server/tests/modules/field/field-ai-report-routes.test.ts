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
  requestFieldPhotoUploadUrl: vi.fn(),
  confirmFieldPhotoUpload: vi.fn(),
  listPendingFieldPhotos: vi.fn(),
  assignPendingFieldPhotoTarget: vi.fn(),
}));
// ONLY the pool-dependent functions are replaced. assertValidUuid and assertValidCaptureTargetIds are pure
// validators that the route depends on for its 400s — stubbing them to no-ops made every id in this file
// pass a check production actually performs, so the malformed-id paths below were never really exercised.
vi.mock("../../../src/modules/field/photos-service.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../src/modules/field/photos-service.js")>()),
  ...photoMocks,
}));

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
  // Must mirror the REAL exports the route imports — a missing one is `undefined` at the call site and
  // 500s every request (which is how the focus-prompt cap silently went untested the first time).
  // A real class, so the route's `instanceof` check behaves as it does in production.
  AiReportQuotaExceededError: class AiReportQuotaExceededError extends Error {
    constructor(readonly limit: number) {
      super(`Quota of ${limit} concurrent AI reports reached.`);
      this.name = "AiReportQuotaExceededError";
    }
  },
  // The ROLLING cap, mirrored for the same reason: the route narrows on it before the concurrency error, so
  // an undefined here makes `instanceof` throw and every enqueue path 500s.
  AiReportDailyQuotaExceededError: class AiReportDailyQuotaExceededError extends Error {
    constructor(readonly limit: number) {
      super(`Quota of ${limit} AI reports per day reached.`);
      this.name = "AiReportDailyQuotaExceededError";
    }
  },
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
  // mockReset, not just clearAllMocks: a `...Once` rejection queued by a test that did not consume it (or
  // consumed it on a different path) survives clearAllMocks and fires in the NEXT test, which shows up as a
  // baffling wrong-status failure several tests later.
  runMocks.insertAiReportRunTx.mockReset();
  runMocks.getInFlightAiReportRun.mockReset();
  runMocks.expireStaleAiReportRuns.mockReset();
  runMocks.getAiReportRun.mockReset();

  aiMocks.isAiReportConfigured.mockReturnValue(true);
  runMocks.expireStaleAiReportRuns.mockResolvedValue(0 as any);
  runMocks.insertAiReportRunTx.mockResolvedValue({ id: "run-1", status: "queued" } as any);
  // No identical run in flight by default — the route now checks this BEFORE the quota so a lost-202 retry
  // can resume its original run instead of being rejected.
  runMocks.getInFlightAiReportRun.mockResolvedValue(null as any);
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

    // User-scoped, not project-scoped: abandoned runs on OTHER projects still occupy the per-user quota,
    // and a project-scoped sweep could never clear them.
    expect(runMocks.expireStaleAiReportRuns).toHaveBeenCalledWith("user-1");
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
      reportTitle: null,
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

    // The point is that it surfaces as a 500 rather than being mistaken for a duplicate and answered 202.
    expect(res.status).toBe(500);
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

  it("caps a user's concurrent runs across ALL projects, not just this one", async () => {
    // The in-flight unique index is per (project, requester), and a field user can reach every active
    // project — so without this one account could queue a paid 60-photo run for each of them in sequence.
    // The quota is refused by the INSERT itself (atomic), not by a pre-check that a parallel burst walks past.
    const quota = new runMocks.AiReportQuotaExceededError(3);
    runMocks.insertAiReportRunTx.mockRejectedValueOnce(quota as never);

    const res = await request(buildApp())
      .post("/api/field/reports/ai-generate")
      .send({ projectId: PROJECT, photoIds: [PHOTO_A] });

    expect(res.status).toBe(429);
    expect(res.body.error.message).toMatch(/already have 3 AI reports/i);
  });

  it("lets an identical retry resume its run even when the user is at quota", async () => {
    // A retry of the same request creates no new work. Rejecting it on quota would strip the client of the
    // only run id it can poll, so the duplicate check runs BEFORE the quota.
    runMocks.getInFlightAiReportRun.mockResolvedValue({
      id: "run-existing",
      status: "running",
      photoIds: [PHOTO_A],
      focusPrompt: null,
      reportTitle: null,
    } as never);

    const res = await request(buildApp())
      .post("/api/field/reports/ai-generate")
      .send({ projectId: PROJECT, photoIds: [PHOTO_A] });

    expect(res.status).toBe(202);
    expect(res.body).toEqual({ runId: "run-existing", status: "running" });
    expect(runMocks.insertAiReportRunTx).not.toHaveBeenCalled();
  });

  it("reports the ROLLING daily cap distinctly from the concurrency cap", async () => {
    // "Wait for one to finish" is useless advice to someone who has hit the daily limit — nothing they wait
    // for frees it up. The two rejections are different errors for exactly that reason.
    runMocks.insertAiReportRunTx.mockRejectedValueOnce(new runMocks.AiReportDailyQuotaExceededError(25) as never);

    const res = await request(buildApp())
      .post("/api/field/reports/ai-generate")
      .send({ projectId: PROJECT, photoIds: [PHOTO_A] });

    expect(res.status).toBe(429);
    expect(res.body.error.message).toMatch(/daily limit/i);
    expect(res.body.error.message).not.toMatch(/wait for one to finish/i);
  });

  it("resolves an identical double-tap that reached the quota instead of the in-flight index", async () => {
    // The pre-flight duplicate check ran BEFORE the concurrent request committed, so this one gets as far
    // as the INSERT. With the user's other runs already at the ceiling, the winner's commit takes them to
    // the limit and the advisory-lock-serialised count refuses this one before the in-flight index can —
    // so the duplicate arrives at the quota branch. 429-ing it would report a limit the user did not hit
    // and strip the client of the run id it needs to poll.
    runMocks.getInFlightAiReportRun
      .mockResolvedValueOnce(null as never) // pre-check: the winner has not committed yet
      .mockResolvedValueOnce({              // after the refusal: it has
        id: "run-winner",
        status: "queued",
        photoIds: [PHOTO_A],
        focusPrompt: null,
        reportTitle: null,
      } as never);
    runMocks.insertAiReportRunTx.mockRejectedValueOnce(new runMocks.AiReportQuotaExceededError(3) as never);

    const res = await request(buildApp())
      .post("/api/field/reports/ai-generate")
      .send({ projectId: PROJECT, photoIds: [PHOTO_A] });

    expect(res.status).toBe(202);
    expect(res.body).toEqual({ runId: "run-winner", status: "queued" });
  });

  it("still reports the quota when the refused request is not a duplicate", async () => {
    // The counterweight: the recovery above must not swallow a genuine quota rejection just because some
    // other run happens to be in flight for this project.
    runMocks.getInFlightAiReportRun
      .mockResolvedValueOnce(null as never)
      .mockResolvedValueOnce({
        id: "run-other",
        status: "running",
        photoIds: [PHOTO_B], // a different selection — not the same request
        focusPrompt: null,
        reportTitle: null,
      } as never);
    runMocks.insertAiReportRunTx.mockRejectedValueOnce(new runMocks.AiReportQuotaExceededError(3) as never);

    const res = await request(buildApp())
      .post("/api/field/reports/ai-generate")
      .send({ projectId: PROJECT, photoIds: [PHOTO_A] });

    expect(res.status).toBe(429);
    expect(res.body.error.message).toMatch(/already have 3 AI reports/i);
  });

  it("treats a different report title as a different request", async () => {
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
      reportTitle: "Roof survey",
    } as never);

    const res = await request(buildApp())
      .post("/api/field/reports/ai-generate")
      .send({ projectId: PROJECT, photoIds: [PHOTO_A], reportTitle: "Structural survey" });

    // Returning the first run would hand back a PDF titled something this caller never asked for.
    expect(res.status).toBe(409);
  });

  it("rejects an empty selection", async () => {
    const res = await request(buildApp()).post("/api/field/reports/ai-generate").send({ projectId: PROJECT, photoIds: [] });
    expect(res.status).toBe(400);
    expect(runMocks.insertAiReportRunTx).not.toHaveBeenCalled();
  });

  it("rejects a malformed photo id before enqueuing anything", async () => {
    // The route validates every selected id, not just the project — a non-uuid reaching the insert would
    // become a `::uuid` cast error surfaced as a 500. Exercised against the REAL validator, which this
    // file used to stub out.
    const res = await request(buildApp())
      .post("/api/field/reports/ai-generate")
      .send({ projectId: PROJECT, photoIds: [PHOTO_A, "not-a-uuid"] });
    expect(res.status).toBe(400);
    expect(res.body.error.message).toMatch(/photoId/i);
    expect(runMocks.insertAiReportRunTx).not.toHaveBeenCalled();
  });

  it("rejects a malformed project id before enqueuing anything", async () => {
    const res = await request(buildApp())
      .post("/api/field/reports/ai-generate")
      .send({ projectId: "definitely-not-a-uuid", photoIds: [PHOTO_A] });
    expect(res.status).toBe(400);
    expect(res.body.error.message).toMatch(/projectId/i);
    expect(runMocks.insertAiReportRunTx).not.toHaveBeenCalled();
  });

  it("rejects a request with no JSON body as a 400, not a 500", async () => {
    // Under express 5 body-parser leaves req.body UNDEFINED when the content-type isn't JSON, so reading a
    // field straight off it threw a TypeError and the client saw an opaque 500.
    const res = await request(buildApp()).post("/api/field/reports/ai-generate");
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
