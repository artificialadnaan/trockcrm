import { describe, it, expect } from "vitest";
import { handleAiReportGeneration, isCandidateMissing } from "../../src/jobs/ai-report-generation.js";

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
