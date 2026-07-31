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

/**
 * True only for "THIS candidate does not exist" — never for a module that exists and failed to initialise.
 *
 * The error code alone is not enough: a candidate that IS present but imports something missing raises
 * ERR_MODULE_NOT_FOUND too, and treating that as "try the next path" would bury a real dependency problem
 * behind the fallback's own resolution failure. Node names the unresolved specifier in the message, so the
 * candidate is only skipped when the thing that could not be found IS the candidate. Compared on the path
 * tail because the message carries a resolved absolute path while the candidate is written relative.
 */
export function isCandidateMissing(error: unknown, candidate: string): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  if (code !== "ERR_MODULE_NOT_FOUND" && code !== "MODULE_NOT_FOUND") return false;
  const message = (error as { message?: unknown } | null)?.message;
  if (typeof message !== "string") return false;
  // ONLY the quoted specifier may be compared. Both message forms name the candidate somewhere else when
  // the real problem is inside it: ESM writes "Cannot find module '<specifier>' imported from '<importer>'",
  // and CommonJS writes "Cannot find module '<specifier>'\nRequire stack:\n- <importer>". Matching anything
  // beyond the quoted name reads the candidate's appearance as an IMPORTER as "the candidate is absent" and
  // falls through, hiding the missing dependency behind the fallback's own resolution error.
  const specifier = /Cannot find module ['"]([^'"]+)['"]/.exec(message)?.[1];
  // An unrecognised message shape is treated as NOT-missing on purpose: propagating a real error beats
  // silently trying the next path.
  if (!specifier) return false;
  return specifier.includes(candidate.replace(/^(?:\.\.\/)+/, ""));
}

async function importFirstAvailable<T>(paths: readonly string[]): Promise<T> {
  let lastError: unknown;
  for (const path of paths) {
    try {
      return (await import(path)) as T;
    } catch (error) {
      // Fall through ONLY when THIS candidate isn't there. If the module exists and its own initialisation
      // threw — a missing env var, a bad top-level import, an absent transitive dependency — trying the next
      // candidate buries the real cause behind whatever the fallback reports, which in production (where
      // only `dist` exists) is a bare "cannot find module server/src/...". Propagate that immediately.
      if (!isCandidateMissing(error, path)) throw error;
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
