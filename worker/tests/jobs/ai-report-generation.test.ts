import { beforeEach, describe, it, expect, vi } from "vitest";

// The shim writes its dead-letter reconciliation through the WORKER's pool (never a server module — the
// case it exists for is the server import failing), so the pool is what has to be observable here.
const dbMocks = vi.hoisted(() => ({
  pool: { query: vi.fn(async () => ({ rows: [], rowCount: 1 })) },
}));
vi.mock("../../src/db.js", () => dbMocks);

const { handleAiReportGeneration, isCandidateMissing } = await import("../../src/jobs/ai-report-generation.js");

const RUN_ID = "11111111-1111-1111-1111-111111111111";
const FINAL = { attempt: 3, maxAttempts: 3, isFinalAttempt: true };
const NOT_FINAL = { attempt: 1, maxAttempts: 3, isFinalAttempt: false };

beforeEach(() => {
  vi.clearAllMocks();
});

/**
 * The worker job is a thin shim over the server orchestrator (server/src/modules/field/ai-report-job.ts),
 * reached by dynamic import because sharp/pdfkit are not worker dependencies. What is worth pinning here is
 * the shim's OWN logic — the payload guard. Everything past the import is covered by the server-side suites
 * (ai-report-service.test.ts), and exercising it from here would mean a live database.
 *
 * Lives in worker/tests/ rather than colocated in src/ so it runs under both `npm test` and the pre-merge
 * gate without depending on the gate's src/**\/*.test.ts glob.
 */
describe("ai_report_generation shim", () => {
  it("rejects a payload with no usable runId rather than burning retries on it", async () => {
    // Unrecoverable by construction: every retry would fail identically, so fail loudly and immediately
    // instead of letting job_queue back off through its whole attempt budget.
    await expect(handleAiReportGeneration({})).rejects.toThrow(/missing runId/);
    await expect(handleAiReportGeneration(null)).rejects.toThrow(/missing runId/);
    await expect(handleAiReportGeneration(undefined)).rejects.toThrow(/missing runId/);
    await expect(handleAiReportGeneration({ runId: "   " })).rejects.toThrow(/missing runId/);
    await expect(handleAiReportGeneration({ runId: null })).rejects.toThrow(/missing runId/);
  });

  it("marks the run failed when the FINAL delivery dies before the server module loads", async () => {
    // The queue is about to mark this delivery 'dead'. Nothing else will ever write a terminal state onto
    // the run — runFieldAiReportJob owns that and was never reached — so the phone would poll a 'queued' run
    // indefinitely while it holds a project slot and a quota slot.
    await expect(handleAiReportGeneration({ runId: RUN_ID }, null, undefined, FINAL)).rejects.toThrow();

    expect(dbMocks.pool.query).toHaveBeenCalledTimes(1);
    const [sql, params] = dbMocks.pool.query.mock.calls[0] as unknown as [string, unknown[]];
    expect(sql).toContain("field_ai_report_runs");
    expect(sql).toContain("status = 'failed'");
    // Guarded on a NON-terminal status so a real outcome that landed meanwhile is never stomped.
    expect(sql).toContain("status IN ('queued', 'running')");
    expect(params[0]).toBe(RUN_ID);
    // The generic driver text never reaches the phone — the run carries the user-facing line.
    expect(String(params[1])).toMatch(/could not be generated/i);
  });

  it("leaves the run alone on an earlier attempt, which is expected to retry", async () => {
    // Failing the run here would make it unclaimable, so the retry that was supposed to fix things would
    // find a terminal run and quietly do nothing.
    await expect(handleAiReportGeneration({ runId: RUN_ID }, null, undefined, NOT_FINAL)).rejects.toThrow();
    expect(dbMocks.pool.query).not.toHaveBeenCalled();
  });

  it("does not reconcile a payload that never had a run id", async () => {
    await expect(handleAiReportGeneration({}, null, undefined, FINAL)).rejects.toThrow(/missing runId/);
    expect(dbMocks.pool.query).not.toHaveBeenCalled();
  });

  describe("isCandidateMissing", () => {
    // The dist->src fallback exists so local `tsx` development can run against server/src while production
    // resolves server/dist. It must fire ONLY when the candidate itself is absent: a candidate that loads
    // and then fails — a missing env var, an absent transitive dependency — has to surface its own error,
    // or the operator sees "cannot find module server/src/..." on a box where only dist was ever expected.
    const CANDIDATE = "../../../server/dist/modules/field/ai-report-job.js";

    it("skips a candidate that genuinely does not resolve", () => {
      const error = Object.assign(
        new Error("Cannot find module '/srv/app/server/dist/modules/field/ai-report-job.js' imported from /srv/app/worker/dist/jobs/x.js"),
        { code: "ERR_MODULE_NOT_FOUND" },
      );
      expect(isCandidateMissing(error, CANDIDATE)).toBe(true);
    });

    it("does NOT skip a candidate whose own dependency is missing", () => {
      // Same error CODE, different unresolved specifier — this one is a real problem inside a module that
      // exists, and falling through to the next path would hide it.
      const error = Object.assign(
        new Error("Cannot find module '/srv/app/node_modules/sharp/lib/index.js' imported from /srv/app/server/dist/modules/field/ai-report-job.js"),
        { code: "ERR_MODULE_NOT_FOUND" },
      );
      expect(isCandidateMissing(error, CANDIDATE)).toBe(false);
    });

    it("does NOT skip a CommonJS dependency failure, where the candidate is in the require stack", () => {
      // The CJS form names the importer under "Require stack:" rather than after "imported from", so a
      // predicate that looked at anything but the quoted specifier saw the candidate in that stack and
      // wrongly declared it absent.
      const error = Object.assign(
        new Error(
          "Cannot find module 'sharp'\nRequire stack:\n- /srv/app/server/dist/modules/field/ai-report-job.js\n- /srv/app/worker/dist/jobs/ai-report-generation.js",
        ),
        { code: "MODULE_NOT_FOUND" },
      );
      expect(isCandidateMissing(error, CANDIDATE)).toBe(false);
    });

    it("does NOT skip on an unrecognised message shape", () => {
      // Conservative by design: propagating a real error beats silently trying the next path.
      expect(isCandidateMissing(Object.assign(new Error("something else entirely"), { code: "ERR_MODULE_NOT_FOUND" }), CANDIDATE)).toBe(false);
    });

    it("does NOT skip an initialisation failure", () => {
      expect(isCandidateMissing(new TypeError("R2_ACCOUNT_ID is required"), CANDIDATE)).toBe(false);
      expect(isCandidateMissing(null, CANDIDATE)).toBe(false);
    });
  });

  it("does not reach the server module for an invalid payload", async () => {
    // The guard must run BEFORE the dynamic import: a bad payload should never pay the cost of loading the
    // server render stack (sharp, pdfkit, the R2 client) just to discover it has nothing to do.
    //
    // Asserted on the error's IDENTITY rather than with a stopwatch. A wall-clock bound is both flaky and
    // vacuous — it passes whether or not the import ran, as long as the machine was quick. Reaching the
    // import first would instead surface a module-resolution or initialisation error from the server tree,
    // which cannot match the guard's message.
    const error = await handleAiReportGeneration({}).then(
      () => { throw new Error("expected the payload guard to reject"); },
      (e: unknown) => e,
    );
    expect((error as Error).message).toBe("ai_report_generation payload is missing runId");
    expect((error as { code?: string }).code).toBeUndefined();
  });
});
