import type { ScorecardKind } from "@trock-crm/shared/types";
import { AppError } from "../../middleware/error-handler.js";
import { assertValidUuid } from "./photos-service.js";

// HTTP-boundary parsing + strict validation for a POST /field/scorecards body. Kept separate from the
// service (which owns scoring/persistence) so it's pure and unit-testable.

export interface ParsedScorecardSubmission {
  clientSubmissionId: string;
  dealId: string;
  weekOf: string;
  formVersion: 1 | 2;
  /** Discriminates the scorecard KIND sharing these tables: 'project' (default) | 'leadership'. */
  kind: ScorecardKind;
  superintendentName: string | null;
  pmName: string | null;
  /** field_responders id when the super/PM was PICKED from the roster (null when typed/none). Shape-validated to
   *  a uuid here; the service further checks it's an ACTIVE responder of the matching role before storing. */
  superintendentResponderId: string | null;
  pmResponderId: string | null;
  projectNumber: string | null;
  items: { sectionKey: string; points: number; note: string | null }[];
  criticalDeficiencies: string[];
  criticalDeficiencyNotes: Record<string, string>;
  actionItems: string[];
  photos: { sectionKey: string; deficiencyKey: string | null; clientUploadId: string }[];
  superintendentSignature: string | null;
  pmSignature: string | null;
  /** Leadership Project Summary free text (voice-dictatable). */
  summary: string | null;
}

export interface ParsedScorecardUpdate {
  expectedUpdatedAt: string;
  superintendentName: string | null;
  pmName: string | null;
  superintendentResponderId: string | null;
  pmResponderId: string | null;
  items: { sectionKey: string; points: number; note: string | null }[];
  criticalDeficiencies: string[];
  criticalDeficiencyNotes: Record<string, string>;
  actionItems: string[];
  photos: Array<
    | { scorecardPhotoId: string; clientUploadId?: never; sectionKey: string; deficiencyKey: string | null }
    | { scorecardPhotoId?: never; clientUploadId: string; sectionKey: string; deficiencyKey: string | null }
  >;
  superintendentSignature: string | null;
  pmSignature: string | null;
  summary: string | null;
}

function strOrNull(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Lenient uuid parse for an OPTIONAL id: a well-formed uuid passes through, anything else (absent, malformed,
// non-string) becomes null. Not a hard 400 — the picked-responder link is optional and the service revalidates
// it against the active roster before storing, so a junk value simply means "no pick" rather than a rejection.
function uuidOrNull(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const v = value.trim();
  return UUID_RE.test(v) ? v : null;
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

  // Leadership is a distinct scorecard KIND stored in the same tables; anything else defaults to project.
  const kind: ScorecardKind = b.kind === "leadership" ? "leadership" : "project";
  // Leadership always uses the V2-style 1-10 average scoring; the client need not send formVersion.
  const formVersion = kind === "leadership" ? 2 : b.formVersion === 2 ? 2 : 1;
  const weekOf = String(b.weekOf ?? "").trim();
  // Validate for EVERY version: the service now persists the client-stamped weekOf as-is for V2/leadership
  // too (it no longer overwrites it server-side), so a blank or calendar-invalid value (e.g. 2026-02-30 from
  // a stale/offline/custom client) must be a clean 400 here — not a Postgres date-cast failure that aborts
  // the insert transaction.
  assertValidWeekOf(weekOf);

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

  // Leadership cards don't support critical deficiencies. Reject a submission that carries any (rather than
  // silently dropping them) so a client bug can't quietly discard an evaluator's flagged concerns — the
  // caller must send an empty set for a leadership card.
  if (kind === "leadership" && (criticalDeficiencies.length > 0 || Object.keys(criticalDeficiencyNotes).length > 0)) {
    throw new AppError(400, "Leadership scorecards do not support critical deficiencies.");
  }

  // Leadership Project Summary free text (voice-dictatable). Bound it here at the boundary so one runaway
  // dictation can't bloat the row/PDF; the service persists it only for leadership cards.
  const summaryRaw = strOrNull(b.summary);
  const summary = summaryRaw ? summaryRaw.slice(0, 8000) : null;

  return {
    clientSubmissionId,
    dealId,
    weekOf,
    formVersion,
    kind,
    superintendentName: strOrNull(b.superintendentName),
    pmName: strOrNull(b.pmName),
    superintendentResponderId: uuidOrNull(b.superintendentResponderId),
    pmResponderId: uuidOrNull(b.pmResponderId),
    projectNumber: strOrNull(b.projectNumber),
    items,
    criticalDeficiencies,
    criticalDeficiencyNotes,
    actionItems,
    photos,
    superintendentSignature: strOrNull(b.superintendentSignature),
    pmSignature: strOrNull(b.pmSignature),
    summary,
  };
}

/** Parse the full editable content accepted by PUT /field/scorecards/:id. Record identity and form shape
 * are deliberately absent: the service derives deal/kind/version/week/creator from the stored card. */
export function parseScorecardUpdate(body: unknown): ParsedScorecardUpdate {
  if (!body || typeof body !== "object") throw new AppError(400, "Missing scorecard body.");
  const b = body as Record<string, unknown>;

  const expectedUpdatedAtRaw = typeof b.expectedUpdatedAt === "string" ? b.expectedUpdatedAt.trim() : "";
  const expectedUpdatedAtDate = expectedUpdatedAtRaw ? new Date(expectedUpdatedAtRaw) : null;
  if (!expectedUpdatedAtDate || !Number.isFinite(expectedUpdatedAtDate.getTime())) {
    throw new AppError(400, "expectedUpdatedAt must be a valid timestamp.");
  }
  // Normalize equivalent timestamp spellings to the same token emitted by the API.
  const expectedUpdatedAt = expectedUpdatedAtDate.toISOString();

  if (!Array.isArray(b.items) || b.items.length === 0) {
    throw new AppError(400, "items are required.");
  }
  if (b.items.length > 30) throw new AppError(400, "Too many scorecard items.");
  const items = b.items.map((raw) => {
    const it = (raw ?? {}) as Record<string, unknown>;
    if (typeof it.points !== "number" || !Number.isInteger(it.points)) {
      throw new AppError(400, "Each scorecard item needs an explicit integer points value.");
    }
    return { sectionKey: String(it.sectionKey ?? ""), points: it.points, note: strOrNull(it.note) };
  });

  const photos: ParsedScorecardUpdate["photos"] = Array.isArray(b.photos)
    ? b.photos.map((raw) => {
        const photo = (raw ?? {}) as Record<string, unknown>;
        const scorecardPhotoId = typeof photo.scorecardPhotoId === "string" ? photo.scorecardPhotoId.trim() : "";
        const clientUploadId = typeof photo.clientUploadId === "string" ? photo.clientUploadId.trim() : "";
        if ((scorecardPhotoId ? 1 : 0) + (clientUploadId ? 1 : 0) !== 1) {
          throw new AppError(400, "Each evidence photo needs exactly one scorecardPhotoId or clientUploadId.");
        }
        const common = {
          sectionKey: String(photo.sectionKey ?? ""),
          deficiencyKey: strOrNull(photo.deficiencyKey),
        };
        if (scorecardPhotoId) {
          assertValidUuid(scorecardPhotoId, "scorecardPhotoId");
          return { ...common, scorecardPhotoId };
        }
        return { ...common, clientUploadId };
      })
    : [];
  if (photos.length > 100) throw new AppError(400, "Too many evidence photos.");

  const criticalDeficiencies = Array.isArray(b.criticalDeficiencies)
    ? b.criticalDeficiencies.filter((x): x is string => typeof x === "string")
    : [];
  const criticalDeficiencyNotes =
    b.criticalDeficiencyNotes && typeof b.criticalDeficiencyNotes === "object" && !Array.isArray(b.criticalDeficiencyNotes)
      ? Object.fromEntries(
          Object.entries(b.criticalDeficiencyNotes as Record<string, unknown>)
            .filter(([, value]) => typeof value === "string" && value.trim().length > 0)
            .map(([key, value]) => [key, (value as string).trim().slice(0, 4000)]),
        )
      : {};
  const actionItems = Array.isArray(b.actionItems)
    ? b.actionItems
        .filter((x): x is string => typeof x === "string" && x.trim().length > 0)
        .map((x) => x.trim())
    : [];
  if (criticalDeficiencies.length > 30) throw new AppError(400, "Too many critical deficiencies.");
  if (actionItems.length > 50) throw new AppError(400, "Too many action items.");

  const summaryRaw = strOrNull(b.summary);
  return {
    expectedUpdatedAt,
    superintendentName: strOrNull(b.superintendentName),
    pmName: strOrNull(b.pmName),
    superintendentResponderId: uuidOrNull(b.superintendentResponderId),
    pmResponderId: uuidOrNull(b.pmResponderId),
    items,
    criticalDeficiencies,
    criticalDeficiencyNotes,
    actionItems,
    photos,
    superintendentSignature: strOrNull(b.superintendentSignature),
    pmSignature: strOrNull(b.pmSignature),
    summary: summaryRaw ? summaryRaw.slice(0, 8000) : null,
  };
}
