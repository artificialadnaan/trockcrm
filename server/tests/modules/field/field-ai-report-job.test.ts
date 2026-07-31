import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The orchestrator: claim → load → model → render → record. Its two load-bearing properties are the ones
 * that are invisible in a passing PDF, so they are asserted directly here:
 *   1. the model call happens OUTSIDE any office transaction (a 30-90s call inside one pins a pooled
 *      connection with a 30s statement_timeout — the documented cause of pool saturation), and
 *   2. every selected photo still prints, with an override ONLY for the ones the model wrote about.
 */

const runMocks = vi.hoisted(() => ({
  getAiReportRun: vi.fn(),
  markAiReportRunRunning: vi.fn(async () => true),
  markAiReportRunSucceeded: vi.fn(async () => undefined),
  markAiReportRunFailed: vi.fn(async () => undefined),
  touchAiReportRunLease: vi.fn(async () => true),
  AI_REPORT_JOB_TYPE: "ai_report_generation",
}));
vi.mock("../../../src/modules/field/ai-report-runs.js", () => runMocks);

const aiMocks = vi.hoisted(() => ({
  generateAiPhotoAssessment: vi.fn(),
  serializeFinding: (f: { title: string; bullets: string[] }) =>
    [f.title, ...f.bullets.map((b) => `- ${b}`)].join("\n"),
  AiReportError: class AiReportError extends Error {
    constructor(message: string, readonly retryable: boolean) {
      super(message);
    }
  },
  MAX_FOCUS_PROMPT_LENGTH: 1_000,
  isAiReportConfigured: vi.fn(() => true),
}));
vi.mock("../../../src/modules/field/ai-report-service.js", () => aiMocks);

const reportMocks = vi.hoisted(() => ({
  prepareFieldPhotoReport: vi.fn(),
  renderAndStoreFieldPhotoReportPdf: vi.fn(),
  recordFieldPhotoReportFile: vi.fn(),
}));
vi.mock("../../../src/modules/field/photo-reports-service.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../src/modules/field/photo-reports-service.js")>()),
  ...reportMocks,
}));

const projectMocks = vi.hoisted(() => ({
  assertActiveFieldProject: vi.fn(),
}));
vi.mock("../../../src/modules/field/projects-service.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../src/modules/field/projects-service.js")>()),
  ...projectMocks,
}));

// Phase E deletes the uploaded object when its re-validation rejects the report, so the delete has to be
// observable. Everything else in r2-client stays real — pdf-layout reads from it during a real render.
// The job re-applies the office authorization the enqueue middleware performed, so the canonical check has
// to be observable. Only getOfficeAccess is imported from this module.
const authMocks = vi.hoisted(() => ({ getOfficeAccess: vi.fn(async () => ({ hasAccess: true })) }));
vi.mock("../../../src/modules/auth/office-access.js", () => authMocks);

const r2Mocks = vi.hoisted(() => ({ deleteObject: vi.fn(async () => undefined) }));
vi.mock("../../../src/lib/r2-client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../src/lib/r2-client.js")>()),
  ...r2Mocks,
}));

vi.mock("../../../src/modules/files/photo-timeline-filters.js", () => ({
  buildDealPhotoTimelineConditions: vi.fn(async () => ({ scope: true })),
}));

// Records the ORDER of interesting events so the phase split can be asserted rather than assumed.
const timeline = vi.hoisted(() => ({ events: [] as string[] }));

const xoMocks = vi.hoisted(() => ({ runInOfficeTransaction: vi.fn(), getFieldOfficeById: vi.fn() }));
vi.mock("../../../src/modules/field/cross-office.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../src/modules/field/cross-office.js")>();
  return {
    ...actual,
    getFieldOfficeById: xoMocks.getFieldOfficeById,
    runInOfficeTransaction: xoMocks.runInOfficeTransaction,
  };
});

const poolMocks = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock("../../../src/db.js", () => ({ pool: poolMocks, db: {} }));

const { runFieldAiReportJob } = await import("../../../src/modules/field/ai-report-job.js");

const PHOTO_A = "aaaaaaaa-1111-1111-1111-111111111111";
const PHOTO_B = "bbbbbbbb-2222-2222-2222-222222222222";

function photoRow(id: string, caption: string | null, overrides: Record<string, unknown> = {}) {
  return {
    id,
    displayName: `IMG_${id.slice(0, 4)}`,
    r2Key: `k/${id}.jpg`,
    mimeType: "image/jpeg",
    caption,
    externalUrl: null,
    externalThumbnailUrl: null,
    ...overrides,
  };
}

/**
 * A drizzle-ish select chain returning the photo rows, on a db handle that records transaction entry.
 *
 * `.where()` is awaited directly by the photo load but chained with `.limit(1)` by Phase E's cleanup
 * reconciliation, so it has to serve both — hence the thenable. `claimedRows` is what that reconciliation
 * sees: non-empty means a committed `files` row already claims the uploaded key.
 */
function officeDb(rows: unknown[], claimedRows: unknown[] = []) {
  return {
    select: () => ({
      from: () => ({
        where: () => ({
          then: (resolve: (value: unknown) => unknown) => resolve(rows),
          limit: async () => claimedRows,
        }),
      }),
    }),
  };
}

function baseRun(overrides: Record<string, unknown> = {}) {
  return {
    id: "run-1",
    dealId: "deal-1",
    officeId: "office-1",
    officeSlug: "dallas",
    requestedBy: "user-1",
    photoIds: [PHOTO_A, PHOTO_B],
    reportTitle: null,
    focusPrompt: null,
    status: "queued",
    fileId: null,
    error: null,
    createdAt: "",
    updatedAt: "",
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  timeline.events = [];
  runMocks.getAiReportRun.mockResolvedValue(baseRun() as any);
  runMocks.markAiReportRunRunning.mockResolvedValue(true);
  // clearAllMocks wipes recorded calls but NOT implementations, so anything a test overrides below has to be
  // restored here or it silently leaks into the next one.
  authMocks.getOfficeAccess.mockResolvedValue({ hasAccess: true });
  xoMocks.getFieldOfficeById.mockImplementation(async (id: string) => ({ id, slug: "dallas" }) as any);
  runMocks.markAiReportRunFailed.mockResolvedValue(undefined);
  runMocks.markAiReportRunSucceeded.mockResolvedValue(undefined);
  runMocks.touchAiReportRunLease.mockImplementation(async () => {
    timeline.events.push("lease:renew");
    return true;
  });
  projectMocks.assertActiveFieldProject.mockImplementation(
    async (_db: any, _access: any, id: string) => ({ id, name: "Tides at Park Lane", dealNumber: "D-1" }) as any,
  );
  poolMocks.query.mockResolvedValue({
    rows: [{ id: "user-1", role: "admin", display_name: "Sam Super", first_name: null, last_name: null, email: "s@t.com", is_active: true }],
  } as any);
  xoMocks.runInOfficeTransaction.mockImplementation(async (office: any, _userId: any, run: any) => {
    timeline.events.push("tx:open");
    const result = await run(officeDb([photoRow(PHOTO_A, "NE flashing"), photoRow(PHOTO_B, null)]), office);
    timeline.events.push("tx:close");
    return result;
  });
  aiMocks.generateAiPhotoAssessment.mockImplementation(async () => {
    timeline.events.push("model:call");
    return {
      executiveSummary: "Summary.",
      findings: [{ photoId: PHOTO_A, title: "North elevation", bullets: ["Rust bleed below the cap flashing."] }],
      reviewedCount: 2,
      usage: { model: "claude-sonnet-5", inputTokens: 10, outputTokens: 5, costUsd: 0.001 },
    };
  });
  reportMocks.prepareFieldPhotoReport.mockImplementation(async (_db: any, _access: any, input: any) => {
    timeline.events.push("prepare");
    return { prepared: true, input } as any;
  });
  reportMocks.renderAndStoreFieldPhotoReportPdf.mockImplementation(async () => {
    timeline.events.push("render+upload");
    return { r2Key: "k" } as any;
  });
  reportMocks.recordFieldPhotoReportFile.mockImplementation(async () => {
    timeline.events.push("record");
    return { report: { id: "file-1", title: "T", pdfUrl: "u", expiresAt: null, createdAt: "" } } as any;
  });
});

describe("runFieldAiReportJob", () => {
  it("runs BOTH slow steps outside any office transaction", async () => {
    await runFieldAiReportJob({ runId: "run-1" });
    // The two expensive steps — the model call, and rendering + uploading a potentially 60-page PDF — each
    // sit strictly BETWEEN transactions, never inside one. runInOfficeTransaction holds a pooled client
    // under a 30s statement_timeout; minutes of work inside it is the documented pool-saturation failure.
    // If either ever moves inside a transaction, it appears between a tx:open/tx:close pair here.
    expect(timeline.events).toEqual([
      "tx:open", "tx:close",        // Phase A — load project + photos
      "model:call",                 // Phase B — Claude, no transaction held
      "tx:open", "prepare", "tx:close", // Phase C — read what the renderer needs
      "lease:renew",                // renewed BEFORE the unbounded phase, not after it
      "render+upload",              // Phase D — render + R2, no transaction held
      "lease:renew",                // ...and re-checked before publishing, since D can outlast even that
      "tx:open", "record", "tx:close",  // Phase E — write the files row
    ]);
  });

  it("prints every selected photo but overrides only the ones the model wrote about", async () => {
    await runFieldAiReportJob({ runId: "run-1" });

    const input = reportMocks.prepareFieldPhotoReport.mock.calls[0][2] as any;
    expect(input.photoIds ?? input.sections[0].photoIds).toEqual([PHOTO_A, PHOTO_B]);
    expect(input.sections[0].photoOverrides).toEqual([
      { id: PHOTO_A, description: "North elevation\n- Rust bleed below the cap flashing." },
      // null → the renderer falls back to the photo's own stored caption, leaving a
      // passed-over photo reading exactly as the field left it.
      { id: PHOTO_B, description: null },
    ]);
    expect(input.photoLayout).toBe("findings");
  });

  it("hands the crew captions and the focus prompt to the model", async () => {
    runMocks.getAiReportRun.mockResolvedValue(baseRun({ focusPrompt: "roof drainage only" }) as any);
    await runFieldAiReportJob({ runId: "run-1" });

    const [assessmentInput] = aiMocks.generateAiPhotoAssessment.mock.calls[0] as any[];
    expect(assessmentInput.focusPrompt).toBe("roof drainage only");
    expect(assessmentInput.photos.map((p: any) => p.caption)).toEqual(["NE flashing", null]);
    // Selection order is print order and the order the model sees them in.
    expect(assessmentInput.photos.map((p: any) => p.id)).toEqual([PHOTO_A, PHOTO_B]);
  });

  it("records success with the file id and the usage actually spent", async () => {
    const result = await runFieldAiReportJob({ runId: "run-1" });
    expect(result).toEqual({ claimed: true, fileId: "file-1" });
    expect(runMocks.markAiReportRunSucceeded).toHaveBeenCalledWith(
      "run-1",
      "file-1",
      expect.objectContaining({ model: "claude-sonnet-5", costUsd: 0.001 }),
    );
  });

  it("refuses a duplicate delivery without paying for a second model pass", async () => {
    // job_queue can redeliver after a worker dies mid-flight; a second pass costs real money and would
    // file a second PDF for one tap.
    runMocks.markAiReportRunRunning.mockResolvedValue(false);
    runMocks.getAiReportRun.mockResolvedValue(baseRun({ status: "succeeded" }) as any);
    const result = await runFieldAiReportJob({ runId: "run-1" });
    // Already terminal → the queue may complete this delivery; no deferral.
    expect(result).toEqual({ claimed: false, retryAfterSeconds: undefined });
    expect(aiMocks.generateAiPhotoAssessment).not.toHaveBeenCalled();
    expect(reportMocks.prepareFieldPhotoReport).not.toHaveBeenCalled();
  });

  it("defers redelivery when the run is still held by a live attempt", async () => {
    // recoverStaleJobs requeues the QUEUE row after 5 minutes while a run stays protected for 20. Returning
    // plain "not claimed" would let processJob mark the redelivered job COMPLETED, and nothing would ever
    // come back for the run — it would sit in 'running' until the sweep expired it.
    runMocks.markAiReportRunRunning.mockResolvedValue(false);
    runMocks.getAiReportRun.mockResolvedValue(baseRun({ status: "running" }) as any);

    const result = await runFieldAiReportJob({ runId: "run-1" });
    expect(result.claimed).toBe(false);
    expect(result.retryAfterSeconds).toBeGreaterThan(0);
    expect(aiMocks.generateAiPhotoAssessment).not.toHaveBeenCalled();
  });

  it("records a model failure on the run instead of throwing it back at the queue", async () => {
    // The run row is what the phone polls. Re-throwing would make job_queue retry a run already reported
    // as failed — and re-spend on the model. An AiReportError's message is written for the user, so it is
    // passed through verbatim.
    aiMocks.generateAiPhotoAssessment.mockRejectedValue(
      new aiMocks.AiReportError("Claude request timed out.", true),
    );
    const result = await runFieldAiReportJob({ runId: "run-1" });
    expect(result).toEqual({ claimed: true });
    expect(runMocks.markAiReportRunFailed).toHaveBeenCalledWith("run-1", "Claude request timed out.", null);
    expect(runMocks.markAiReportRunSucceeded).not.toHaveBeenCalled();
  });

  it("never puts a raw driver error on the run row — that text reaches the phone", async () => {
    // drizzle's DrizzleQueryError message is the entire failing SQL plus its bound parameters.
    const leaky = new Error("Failed query: INSERT INTO office_dallas.files (...) params: user-1,secret-key");
    reportMocks.renderAndStoreFieldPhotoReportPdf.mockRejectedValue(leaky);
    await runFieldAiReportJob({ runId: "run-1" });

    const [, storedMessage] = runMocks.markAiReportRunFailed.mock.calls[0];
    expect(storedMessage).not.toContain("INSERT INTO");
    expect(storedMessage).not.toContain("secret-key");
    expect(storedMessage).toMatch(/could not be generated/i);
  });

  it("still records the spend when the run dies AFTER the model call", async () => {
    reportMocks.renderAndStoreFieldPhotoReportPdf.mockRejectedValue(new Error("R2 unavailable"));
    await runFieldAiReportJob({ runId: "run-1" });
    // Usage is attributed even though the report never landed — the tokens were already bought.
    expect(runMocks.markAiReportRunFailed).toHaveBeenCalledWith(
      "run-1",
      expect.stringMatching(/could not be generated/i),
      expect.objectContaining({ model: "claude-sonnet-5" }),
    );
  });

  it("carries the spend accrued before a mid-run model failure onto the ledger", async () => {
    // Batches that completed before the failure were paid for; reporting $0 would under-count real spend.
    const partial = new aiMocks.AiReportError("Claude request failed: 529", true);
    (partial as { usage?: unknown }).usage = {
      model: "claude-sonnet-5",
      inputTokens: 45_000,
      outputTokens: 9_000,
      costUsd: 0.27,
    };
    aiMocks.generateAiPhotoAssessment.mockRejectedValue(partial);

    await runFieldAiReportJob({ runId: "run-1" });
    expect(runMocks.markAiReportRunFailed).toHaveBeenCalledWith(
      "run-1",
      "Claude request failed: 529",
      expect.objectContaining({ inputTokens: 45_000, costUsd: 0.27 }),
    );
  });

  it("fails a run whose photos are no longer in the project's scope", async () => {
    xoMocks.runInOfficeTransaction.mockImplementation(async (office: any, _userId: any, run: any) =>
      run(officeDb([photoRow(PHOTO_A, null)]), office),
    );
    await runFieldAiReportJob({ runId: "run-1" });
    expect(runMocks.markAiReportRunFailed).toHaveBeenCalledWith("run-1", expect.stringMatching(/unavailable/i), null);
    expect(aiMocks.generateAiPhotoAssessment).not.toHaveBeenCalled();
  });

  it("rejects a payload with no runId", async () => {
    await expect(runFieldAiReportJob({ runId: "" })).rejects.toThrow(/missing runId/);
  });

  it("throws for an unknown run so the queue can retry a lost row", async () => {
    runMocks.getAiReportRun.mockResolvedValue(null as any);
    await expect(runFieldAiReportJob({ runId: "run-404" })).rejects.toThrow(/not found/);
  });

  it("refuses to run for a requester deactivated while the run sat queued", async () => {
    // requireFieldContractor gated the ENQUEUE, but the serial poller can leave a run queued for minutes.
    // Without a re-check the worker spends on the model and files a report as a deactivated account.
    poolMocks.query.mockResolvedValue({
      rows: [{ id: "user-1", role: "admin", display_name: "Sam", first_name: null, last_name: null, email: "s@t.com", is_active: false }],
    } as any);

    await runFieldAiReportJob({ runId: "run-1" });

    // Refused BEFORE the expensive part — no model call, no PDF, no file row.
    expect(aiMocks.generateAiPhotoAssessment).not.toHaveBeenCalled();
    expect(reportMocks.renderAndStoreFieldPhotoReportPdf).not.toHaveBeenCalled();
    expect(reportMocks.recordFieldPhotoReportFile).not.toHaveBeenCalled();
    // The phone still gets a terminal reason rather than a run that hangs.
    expect(runMocks.markAiReportRunFailed).toHaveBeenCalledWith("run-1", expect.stringMatching(/no longer has access/i), null);
  });

  it("refuses to run when access to the run's OFFICE was revoked while it sat queued", async () => {
    // The account can still be perfectly valid — active, right role — while the secondary-office grant that
    // allowed this run is gone. Nothing downstream re-checks it: runInOfficeTransaction selects the schema,
    // it does not authorize, so the report would be filed into an office the user can no longer write to.
    authMocks.getOfficeAccess.mockResolvedValue({ hasAccess: false });

    await runFieldAiReportJob({ runId: "run-1" });

    // Checked against the RUN's office, not the requester's current one.
    expect(authMocks.getOfficeAccess).toHaveBeenCalledWith("user-1", "office-1");
    expect(aiMocks.generateAiPhotoAssessment).not.toHaveBeenCalled();
    expect(reportMocks.recordFieldPhotoReportFile).not.toHaveBeenCalled();
    expect(runMocks.markAiReportRunFailed).toHaveBeenCalledWith(
      "run-1",
      expect.stringMatching(/no longer have access to the office/i),
      null,
    );
  });

  it("still runs a cross-office report when the writes flag is ON and no grant exists", async () => {
    // With the flag ON the enqueue resolves the DEAL's owning office and never asks for a user_office_access
    // grant — so demanding one here would fail runs that were deliberately accepted, and only after the user
    // had already been told 202. The gate in that mode is the account checks plus assertActiveFieldProject.
    const previous = process.env.FIELD_CROSS_OFFICE_WRITES_ENABLED;
    process.env.FIELD_CROSS_OFFICE_WRITES_ENABLED = "true";
    authMocks.getOfficeAccess.mockResolvedValue({ hasAccess: false });
    try {
      const result = await runFieldAiReportJob({ runId: "run-1" });

      expect(result).toEqual({ claimed: true, fileId: "file-1" });
      expect(aiMocks.generateAiPhotoAssessment).toHaveBeenCalled();
      // The grant is not even consulted in this mode.
      expect(authMocks.getOfficeAccess).not.toHaveBeenCalled();
    } finally {
      if (previous === undefined) delete process.env.FIELD_CROSS_OFFICE_WRITES_ENABLED;
      else process.env.FIELD_CROSS_OFFICE_WRITES_ENABLED = previous;
    }
  });

  it("refuses to run for a requester whose role is outside the field-app set", async () => {
    // A backstop rather than a live path: every currently assignable role is field-app allowed, but the
    // column is not constrained to that enum and the list could narrow.
    poolMocks.query.mockResolvedValue({
      rows: [{ id: "user-1", role: "legacy_role", display_name: "Sam", first_name: null, last_name: null, email: "s@t.com", is_active: true }],
    } as any);

    await runFieldAiReportJob({ runId: "run-1" });

    expect(aiMocks.generateAiPhotoAssessment).not.toHaveBeenCalled();
    expect(runMocks.markAiReportRunFailed).toHaveBeenCalledWith("run-1", expect.stringMatching(/no longer has access/i), null);
  });

  it("does not re-run a failed assessment when the terminal write itself fails", async () => {
    // The generation already failed; only the status write blipped. Letting that escape hands the queue a
    // throw while the row is still 'running' — the redelivery cannot claim it, is deferred until the
    // 20-minute lease expires, and then repeats the WHOLE assessment, paying for the model again purely
    // because a status write failed. expireStaleAiReportRuns reconciles the row instead.
    aiMocks.generateAiPhotoAssessment.mockRejectedValue(new aiMocks.AiReportError("Claude timed out.", true));
    // Once, not a standing rejection: an implementation set here survives clearAllMocks and would otherwise
    // leak into every later test in this file.
    runMocks.markAiReportRunFailed.mockRejectedValueOnce(new Error("connection terminated unexpectedly"));

    // Must RESOLVE, not reject: a rejection is what triggers the queue retry.
    await expect(runFieldAiReportJob({ runId: "run-1" })).resolves.toEqual({ claimed: true });
    expect(runMocks.markAiReportRunFailed).toHaveBeenCalled();
  });

  it("carries an external-only photo's URLs through to the assessment", async () => {
    // The mapper used to pass r2Key alone, so a CompanyCam-style row arrived with nothing to read and the
    // vision pass skipped it — an all-external selection failed the whole run.
    xoMocks.runInOfficeTransaction.mockImplementation(async (office: any, _userId: any, run: any) =>
      run(
        officeDb([
          photoRow(PHOTO_A, null, { r2Key: null, externalUrl: "https://cdn.example.com/a.jpg" }),
          photoRow(PHOTO_B, null),
        ]),
        office,
      ),
    );

    await runFieldAiReportJob({ runId: "run-1" });

    const photos = (aiMocks.generateAiPhotoAssessment.mock.calls[0][0] as any).photos;
    expect(photos[0]).toMatchObject({ id: PHOTO_A, r2Key: null, externalUrl: "https://cdn.example.com/a.jpg" });
  });

  it("renews the lease on the run it is actually working", async () => {
    // started_at doubles as the lease and is stamped once at claim, but only the model call is
    // deadline-bounded — Phase D is deliberately unbounded. Without a renewal a slow-but-healthy run crosses
    // the stale window, the user's next enqueue reaps it, and they pay for a replacement while this attempt
    // is still working. (The ORDER — before the render, not after — is pinned by the phase-split test above.)
    await runFieldAiReportJob({ runId: "run-1" });
    expect(runMocks.touchAiReportRunLease).toHaveBeenCalledWith("run-1");
  });

  it("abandons the attempt when the lease is already lost rather than rendering a duplicate", async () => {
    runMocks.touchAiReportRunLease.mockImplementation(async () => {
      timeline.events.push("lease:renew");
      return false;
    });

    const result = await runFieldAiReportJob({ runId: "run-1" });

    // The row is terminal and a replacement may already be in flight. Carrying on would upload a second PDF
    // and commit a second files row for a run the user was told had failed — the exact duplicate the
    // guarded terminal write can't prevent, because Phase E commits to `files` regardless.
    expect(result).toEqual({ claimed: true });
    expect(reportMocks.renderAndStoreFieldPhotoReportPdf).not.toHaveBeenCalled();
    expect(reportMocks.recordFieldPhotoReportFile).not.toHaveBeenCalled();
    expect(timeline.events).not.toContain("render+upload");
    // ...and it must not write a terminal state either: one is already recorded, and 'failed' here would be
    // reporting a second failure for a run that was reaped, not one that broke.
    expect(runMocks.markAiReportRunFailed).not.toHaveBeenCalled();
    expect(runMocks.markAiReportRunSucceeded).not.toHaveBeenCalled();
  });

  it("deletes the uploaded PDF when the final re-validation rejects the report", async () => {
    // Phase D uploads BEFORE Phase E validates. recordFieldPhotoReportFile cleans up after its own insert
    // failure, but a project archived or moved to an excluded stage mid-render throws before the insert is
    // ever reached — which left an unreferenced object in the bucket on every such run.
    reportMocks.renderAndStoreFieldPhotoReportPdf.mockImplementation(async () => {
      timeline.events.push("render+upload");
      return { r2Key: "office_dallas/deals/D-1/documents/photo-reports/2026-07/report.pdf" } as any;
    });
    let seen = 0;
    projectMocks.assertActiveFieldProject.mockImplementation(async (_db: any, _access: any, id: string) => {
      seen += 1;
      // Phase A passes; the Phase E re-check is the one that rejects.
      if (seen > 1) throw new Error("Project not found");
      return { id, name: "Tides at Park Lane", dealNumber: "D-1" } as any;
    });

    await runFieldAiReportJob({ runId: "run-1" });

    expect(r2Mocks.deleteObject).toHaveBeenCalledWith(
      "office_dallas/deals/D-1/documents/photo-reports/2026-07/report.pdf",
    );
    expect(reportMocks.recordFieldPhotoReportFile).not.toHaveBeenCalled();
    // The run still terminates as a failure the phone can read, not a silent hang.
    expect(runMocks.markAiReportRunFailed).toHaveBeenCalledWith("run-1", expect.any(String), expect.anything());
  });

  it("keeps the PDF when Phase E rejected but the file row is committed anyway", async () => {
    // A transaction can reject AFTER its COMMIT is durable — the connection drops before the acknowledgement
    // arrives. Deleting on that path strips the object out from under a committed `files` row and leaves the
    // user a report that 404s on download, which is strictly worse than the orphan being cleaned up. So the
    // cleanup only fires once it has confirmed nothing claims the key.
    xoMocks.runInOfficeTransaction.mockImplementation(async (office: any, _userId: any, run: any) => {
      timeline.events.push("tx:open");
      // The reconciliation finds a row claiming the uploaded key.
      const result = await run(officeDb([photoRow(PHOTO_A, null), photoRow(PHOTO_B, null)], [{ id: "file-1" }]), office);
      timeline.events.push("tx:close");
      return result;
    });
    let seen = 0;
    projectMocks.assertActiveFieldProject.mockImplementation(async (_db: any, _access: any, id: string) => {
      seen += 1;
      if (seen > 1) throw new Error("connection terminated unexpectedly");
      return { id, name: "Tides at Park Lane", dealNumber: "D-1" } as any;
    });

    await runFieldAiReportJob({ runId: "run-1" });

    expect(r2Mocks.deleteObject).not.toHaveBeenCalled();
  });

  it("leaves the PDF alone when the reconciliation itself cannot be completed", async () => {
    // Uncertainty must not resolve to deletion: an unreferenced object costs storage, a missing one costs
    // the report.
    let seen = 0;
    xoMocks.runInOfficeTransaction.mockImplementation(async (office: any, _userId: any, run: any) => {
      seen += 1;
      // Phase A loads; Phase E rejects; the reconciliation that follows cannot reach the database either.
      if (seen === 1) return run(officeDb([photoRow(PHOTO_A, null), photoRow(PHOTO_B, null)]), office);
      if (seen === 2) return run(officeDb([]), office);
      throw new Error("pool exhausted");
    });
    projectMocks.assertActiveFieldProject.mockImplementation(async (_db: any, _access: any, id: string) => {
      if (seen > 2) throw new Error("Project not found");
      return { id, name: "Tides at Park Lane", dealNumber: "D-1" } as any;
    });

    await runFieldAiReportJob({ runId: "run-1" });

    expect(r2Mocks.deleteObject).not.toHaveBeenCalled();
    expect(runMocks.markAiReportRunFailed).toHaveBeenCalled();
  });

  it("discards the report when a selected photo is deleted during the render", async () => {
    // Deletion is SOFT — the row goes inactive but its R2 object stays readable — so a photo removed during
    // the long Phase D render is still embedded in the PDF that was just uploaded. Checking only the project
    // at Phase E would publish a brand-new downloadable report containing a photograph the user deleted.
    let tx = 0;
    xoMocks.runInOfficeTransaction.mockImplementation(async (office: any, _userId: any, run: any) => {
      tx += 1;
      // Phase A (tx 1) and Phase C (tx 2) see both photos; by Phase E (tx 3) one has left the scope.
      const rows = tx >= 3
        ? [photoRow(PHOTO_A, null)]
        : [photoRow(PHOTO_A, null), photoRow(PHOTO_B, null)];
      return run(officeDb(rows), office);
    });
    reportMocks.renderAndStoreFieldPhotoReportPdf.mockImplementation(async () => ({ r2Key: "office_dallas/report.pdf" } as any));

    await runFieldAiReportJob({ runId: "run-1" });

    // Not published, and the uploaded object does not linger.
    expect(reportMocks.recordFieldPhotoReportFile).not.toHaveBeenCalled();
    expect(r2Mocks.deleteObject).toHaveBeenCalledWith("office_dallas/report.pdf");
    expect(runMocks.markAiReportRunFailed).toHaveBeenCalledWith(
      "run-1",
      expect.stringMatching(/unavailable/i),
      expect.anything(),
    );
  });

  it("discards the report when the office is deactivated during the render", async () => {
    // Everything from Phase A on uses the office object cached before the render. Recording against a
    // deactivated office would mark the run 'succeeded' while the status endpoint — which resolves the
    // office through the same is_active-gated lookup — answers 404: a success the user can never open.
    reportMocks.renderAndStoreFieldPhotoReportPdf.mockImplementation(async () => {
      timeline.events.push("render+upload");
      return { r2Key: "office_dallas/report.pdf" } as any;
    });
    let lookups = 0;
    xoMocks.getFieldOfficeById.mockImplementation(async (id: string) => {
      lookups += 1;
      // Phase A resolves it; by the Phase E re-resolve the office is gone.
      if (lookups > 1) throw new Error("Office not found or inactive");
      return { id, slug: "dallas" } as any;
    });

    await runFieldAiReportJob({ runId: "run-1" });

    expect(reportMocks.recordFieldPhotoReportFile).not.toHaveBeenCalled();
    expect(r2Mocks.deleteObject).toHaveBeenCalledWith("office_dallas/report.pdf");
    expect(runMocks.markAiReportRunFailed).toHaveBeenCalled();
  });

  it("does not publish a report whose lease was lost during the render", async () => {
    // Rendering is unbounded and can outlast even a freshly renewed lease, at which point the requester's
    // next enqueue reaps this run and starts a replacement. Committing the file anyway would leave the
    // phone showing 'failed' beside a report that exists, while the replacement bills a second assessment.
    reportMocks.renderAndStoreFieldPhotoReportPdf.mockImplementation(async () => {
      timeline.events.push("render+upload");
      return { r2Key: "office_dallas/report.pdf" } as any;
    });
    // Held before the render, lost by the time it is time to publish.
    runMocks.touchAiReportRunLease
      .mockImplementationOnce(async () => { timeline.events.push("lease:renew"); return true; })
      .mockImplementationOnce(async () => false);

    await runFieldAiReportJob({ runId: "run-1" });

    expect(reportMocks.recordFieldPhotoReportFile).not.toHaveBeenCalled();
    expect(r2Mocks.deleteObject).toHaveBeenCalledWith("office_dallas/report.pdf");
    expect(runMocks.markAiReportRunSucceeded).not.toHaveBeenCalled();
  });

  it("keeps the uploaded PDF when Phase E succeeds", async () => {
    // The counterweight to the test above: the cleanup must be reachable ONLY on the failure path, or a
    // perfectly good report loses its object right after it is recorded.
    await runFieldAiReportJob({ runId: "run-1" });
    expect(r2Mocks.deleteObject).not.toHaveBeenCalled();
  });
});
