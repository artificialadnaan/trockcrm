/**
 * `ai_report_generation` — the T Rock Cam "AI Report" job.
 *
 * Deliberately a THIN SHIM. All the work (Claude vision, sharp downscaling, pdfkit render, R2 upload, the
 * cross-office transaction envelope) lives in server/src/modules/field/ai-report-job.ts, because none of
 * those dependencies exist in this workspace: worker/package.json has no sharp, no pdfkit and no
 * s3-request-presigner. Re-implementing them here would mean a second image pipeline and a second PDF
 * renderer drifting against the one the human "Generate PDF" path already uses.
 *
 * The dist-then-src import order mirrors worker/src/jobs/procore-photos.ts: Dockerfile.worker builds the
 * server workspace and copies the whole tree, so `server/dist` is what resolves in production, while local
 * `tsx` development falls through to `server/src`.
 */

const SERVER_AI_REPORT_MODULES = [
  "../../../server/dist/modules/field/ai-report-job.js",
  "../../../server/src/modules/field/ai-report-job.js",
] as const;

type AiReportJobModule = {
  runFieldAiReportJob: (
    payload: { runId: string },
  ) => Promise<{ claimed: boolean; fileId?: string; retryAfterSeconds?: number }>;
};

/** Mirrors JobHandlerResult's deferral shape without importing the queue into this shim. */
export type AiReportShimResult = void | { status: "pending"; error: string; runAfterSeconds: number };

async function importFirstAvailable<T>(paths: readonly string[]): Promise<T> {
  let lastError: unknown;
  for (const path of paths) {
    try {
      return (await import(path)) as T;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error("Unable to import server module");
}

export async function handleAiReportGeneration(payload: unknown): Promise<AiReportShimResult> {
  const runId = String((payload as { runId?: unknown } | null)?.runId ?? "").trim();
  if (!runId) {
    // A payload with no run id can never succeed on a retry — fail loudly rather than burning attempts.
    throw new Error("ai_report_generation payload is missing runId");
  }

  const { runFieldAiReportJob } = await importFirstAvailable<AiReportJobModule>(SERVER_AI_REPORT_MODULES);
  // runFieldAiReportJob records its own terminal outcome on the run row (that row is what the phone polls)
  // and does NOT re-throw a generation failure — a retry would only re-spend on the model for a run already
  // reported as failed. A throw escaping here therefore means an infrastructure fault worth retrying.
  const result = await runFieldAiReportJob({ runId });

  // The run is held by a live attempt. Returning void would let processJob mark this delivery COMPLETED,
  // and nothing would ever come back for the run. Defer instead, so the queue redelivers once the run has
  // become reclaimable.
  if (result.retryAfterSeconds) {
    return {
      status: "pending",
      error: "AI report run is still held by an earlier attempt; retrying after it becomes reclaimable.",
      runAfterSeconds: result.retryAfterSeconds,
    };
  }
}
