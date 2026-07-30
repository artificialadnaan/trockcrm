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
  generateFieldPhotoReport: vi.fn(async () => ({ report: { id: "file-1", title: "T", pdfUrl: "u", expiresAt: null, createdAt: "" } })),
}));
vi.mock("../../../src/modules/field/photo-reports-service.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../src/modules/field/photo-reports-service.js")>()),
  ...reportMocks,
}));

vi.mock("../../../src/modules/field/projects-service.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../src/modules/field/projects-service.js")>()),
  assertActiveFieldProject: vi.fn(async (_db: any, _access: any, id: string) => ({ id, name: "Tides at Park Lane", dealNumber: "D-1" })),
}));

vi.mock("../../../src/modules/files/photo-timeline-filters.js", () => ({
  buildDealPhotoTimelineConditions: vi.fn(async () => ({ scope: true })),
}));

// Records the ORDER of interesting events so the phase split can be asserted rather than assumed.
const timeline = vi.hoisted(() => ({ events: [] as string[] }));

const xoMocks = vi.hoisted(() => ({ runInOfficeTransaction: vi.fn() }));
vi.mock("../../../src/modules/field/cross-office.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../src/modules/field/cross-office.js")>();
  return {
    ...actual,
    getFieldOfficeById: vi.fn(async (id: string) => ({ id, slug: "dallas" })),
    runInOfficeTransaction: xoMocks.runInOfficeTransaction,
  };
});

const poolMocks = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock("../../../src/db.js", () => ({ pool: poolMocks, db: {} }));

const { runFieldAiReportJob } = await import("../../../src/modules/field/ai-report-job.js");

const PHOTO_A = "aaaaaaaa-1111-1111-1111-111111111111";
const PHOTO_B = "bbbbbbbb-2222-2222-2222-222222222222";

function photoRow(id: string, caption: string | null) {
  return { id, displayName: `IMG_${id.slice(0, 4)}`, r2Key: `k/${id}.jpg`, mimeType: "image/jpeg", caption };
}

/** A drizzle-ish select chain returning the photo rows, on a db handle that records transaction entry. */
function officeDb(rows: unknown[]) {
  return {
    select: () => ({ from: () => ({ where: async () => rows }) }),
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
  poolMocks.query.mockResolvedValue({
    rows: [{ id: "user-1", role: "admin", display_name: "Sam Super", first_name: null, last_name: null, email: "s@t.com" }],
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
  reportMocks.generateFieldPhotoReport.mockResolvedValue({
    report: { id: "file-1", title: "T", pdfUrl: "u", expiresAt: null, createdAt: "" },
  } as any);
});

describe("runFieldAiReportJob", () => {
  it("calls the model OUTSIDE any office transaction", async () => {
    await runFieldAiReportJob({ runId: "run-1" });
    // Two separate short transactions with the model call strictly between them. If the model call ever
    // moves inside one, this becomes tx:open,model:call,tx:close and the assertion fails.
    expect(timeline.events).toEqual(["tx:open", "tx:close", "model:call", "tx:open", "tx:close"]);
  });

  it("prints every selected photo but overrides only the ones the model wrote about", async () => {
    await runFieldAiReportJob({ runId: "run-1" });

    const input = reportMocks.generateFieldPhotoReport.mock.calls[0][2] as any;
    expect(input.photoIds ?? input.sections[0].photoIds).toEqual([PHOTO_A, PHOTO_B]);
    expect(input.sections[0].photoOverrides).toEqual([
      { id: PHOTO_A, description: "North elevation\n- Rust bleed below the cap flashing." },
      // null → generateFieldPhotoReport falls back to the photo's own stored caption, leaving a
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
    const result = await runFieldAiReportJob({ runId: "run-1" });
    expect(result).toEqual({ claimed: false });
    expect(aiMocks.generateAiPhotoAssessment).not.toHaveBeenCalled();
    expect(reportMocks.generateFieldPhotoReport).not.toHaveBeenCalled();
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
    reportMocks.generateFieldPhotoReport.mockRejectedValue(leaky);
    await runFieldAiReportJob({ runId: "run-1" });

    const [, storedMessage] = runMocks.markAiReportRunFailed.mock.calls[0];
    expect(storedMessage).not.toContain("INSERT INTO");
    expect(storedMessage).not.toContain("secret-key");
    expect(storedMessage).toMatch(/could not be generated/i);
  });

  it("still records the spend when the run dies AFTER the model call", async () => {
    reportMocks.generateFieldPhotoReport.mockRejectedValue(new Error("R2 unavailable"));
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
});
