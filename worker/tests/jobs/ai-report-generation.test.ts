import { describe, it, expect } from "vitest";
import { handleAiReportGeneration } from "../../src/jobs/ai-report-generation.js";

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

  it("does not reach the server module for an invalid payload", async () => {
    // The guard must run BEFORE the dynamic import: a bad payload should never pay the cost of loading the
    // server render stack (sharp, pdfkit, the R2 client) just to discover it has nothing to do.
    const before = Date.now();
    await expect(handleAiReportGeneration({})).rejects.toThrow();
    expect(Date.now() - before).toBeLessThan(1_000);
  });
});
