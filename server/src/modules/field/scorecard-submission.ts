import { AppError } from "../../middleware/error-handler.js";
import { assertValidUuid } from "./photos-service.js";

// HTTP-boundary parsing + strict validation for a POST /field/scorecards body. Kept separate from the
// service (which owns scoring/persistence) so it's pure and unit-testable.

export interface ParsedScorecardSubmission {
  clientSubmissionId: string;
  dealId: string;
  weekOf: string;
  formVersion: 1 | 2;
  superintendentName: string | null;
  pmName: string | null;
  projectNumber: string | null;
  items: { sectionKey: string; points: number; note: string | null }[];
  criticalDeficiencies: string[];
  criticalDeficiencyNotes: Record<string, string>;
  actionItems: string[];
  photos: { sectionKey: string; deficiencyKey: string | null; clientUploadId: string }[];
  superintendentSignature: string | null;
  pmSignature: string | null;
}

function strOrNull(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
function assertValidWeekOf(weekOf: string): void {
  // Round-trip the components rather than trusting Date.parse — V8 SILENTLY ROLLS OVER calendar-invalid
  // days (2026-02-30 -> Mar 2, non-leap 2026-02-29 -> Mar 1, 2026-04-31 -> May 1), which would then pass
  // here and 500 later on the Postgres `date` cast mid-transaction. Rebuild the date and require every
  // component to survive unchanged, so only real calendar dates are accepted (a 400, not a 500).
  if (!ISO_DATE.test(weekOf)) {
    throw new AppError(400, "weekOf must be a valid date (YYYY-MM-DD).");
  }
  const [y, mo, d] = weekOf.split("-").map(Number);
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) {
    throw new AppError(400, "weekOf must be a valid calendar date (YYYY-MM-DD).");
  }
}

export function parseScorecardSubmission(body: unknown): ParsedScorecardSubmission {
  if (!body || typeof body !== "object") throw new AppError(400, "Missing scorecard body.");
  const b = body as Record<string, unknown>;

  const clientSubmissionId = String(b.clientSubmissionId ?? "");
  const dealId = String(b.dealId ?? "");
  assertValidUuid(clientSubmissionId, "clientSubmissionId");
  assertValidUuid(dealId, "dealId");

  const formVersion = b.formVersion === 2 ? 2 : 1;
  const weekOf = String(b.weekOf ?? "").trim();
  // V2 completion determines the week on the server. V1 remains strict for offline retries of old drafts.
  if (formVersion === 1) assertValidWeekOf(weekOf);

  if (!Array.isArray(b.items) || b.items.length === 0) {
    throw new AppError(400, "items are required.");
  }
  if (b.items.length > 30) throw new AppError(400, "Too many scorecard items.");
  const items = b.items.map((raw) => {
    const it = (raw ?? {}) as Record<string, unknown>;
    const points = it.points;
    // Strict: a missing/null/empty/boolean points must NOT coerce to 0. Every section has a legal
    // 0-point option, so Number(null) === 0 would silently accept an unanswered section as a real score.
    if (typeof points !== "number" || !Number.isInteger(points)) {
      throw new AppError(400, "Each scorecard item needs an explicit integer points value.");
    }
    return { sectionKey: String(it.sectionKey ?? ""), points, note: strOrNull(it.note) };
  });

  const photos = Array.isArray(b.photos)
    ? b.photos.map((raw) => {
        const p = (raw ?? {}) as Record<string, unknown>;
        // A blank/non-string clientUploadId would normalize to "" and could match a file row with an
        // empty client_upload_id — reject it at the boundary instead of linking unrelated evidence.
        const clientUploadId = typeof p.clientUploadId === "string" ? p.clientUploadId.trim() : "";
        if (!clientUploadId) throw new AppError(400, "Each evidence photo needs a clientUploadId.");
        const deficiencyKey = strOrNull(p.deficiencyKey);
        return { sectionKey: String(p.sectionKey ?? ""), deficiencyKey, clientUploadId };
      })
    : [];
  if (photos.length > 100) throw new AppError(400, "Too many evidence photos.");

  // Keep only real strings: `.map(String)` would turn null/{} into "null"/"[object Object]" — for
  // actionItems that would pass the required-action gate as bogus remediation. Deficiencies keep only
  // strings too (the service then validates them against the known keys).
  const criticalDeficiencies = Array.isArray(b.criticalDeficiencies)
    ? b.criticalDeficiencies.filter((x): x is string => typeof x === "string")
    : [];
  const criticalDeficiencyNotes = b.criticalDeficiencyNotes && typeof b.criticalDeficiencyNotes === "object" && !Array.isArray(b.criticalDeficiencyNotes)
    ? Object.fromEntries(
        Object.entries(b.criticalDeficiencyNotes as Record<string, unknown>)
          .filter(([, value]) => typeof value === "string" && value.trim().length > 0)
          .map(([key, value]) => [key, (value as string).trim().slice(0, 4000)]),
      )
    : {};
  const actionItems = Array.isArray(b.actionItems)
    ? b.actionItems.filter((x): x is string => typeof x === "string" && x.trim().length > 0).map((x) => x.trim())
    : [];
  if (criticalDeficiencies.length > 30) throw new AppError(400, "Too many critical deficiencies.");
  if (actionItems.length > 50) throw new AppError(400, "Too many action items.");

  return {
    clientSubmissionId,
    dealId,
    weekOf,
    formVersion,
    superintendentName: strOrNull(b.superintendentName),
    pmName: strOrNull(b.pmName),
    projectNumber: strOrNull(b.projectNumber),
    items,
    criticalDeficiencies,
    criticalDeficiencyNotes,
    actionItems,
    photos,
    superintendentSignature: strOrNull(b.superintendentSignature),
    pmSignature: strOrNull(b.pmSignature),
  };
}
