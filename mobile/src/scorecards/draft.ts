// Pure state engine for the scorecard wizard: a serializable draft + a reducer + derived selectors.
// No React, no native I/O, no Date.now — the draft-store stamps updatedAt on persist and the wizard
// drives it via useReducer. Kept pure so it's unit-testable (and the CI-ungated mobile suite still runs it).

import {
  FIELD_SCORECARD_SECTION_KEYS,
  actionItemsRequired,
  resolveScorecardRating,
  type ScorecardCriticalDeficiencyKey,
  type ScorecardRating,
  type ScorecardSectionKey,
} from "./scoring";

export interface ScorecardDraftPhoto {
  key: string; // local list key
  uri: string; // durable per-draft copy (survives app-kill), not the raw camera uri
  clientUploadId: string; // stamped at capture; resolved to a fileId server-side on submit
  sectionKey: ScorecardSectionKey;
  caption: string;
  // Capture metadata carried so the gallery upload keeps the shot's real time/location + can apply the
  // resize cap (compressForUpload needs width/height to hit the 4032px ceiling). All optional.
  takenAt?: string;
  latitude?: number;
  longitude?: number;
  // Source of the coordinates ("exif" vs live-GPS fallback) — forwarded to the upload so live_gps evidence
  // isn't audited as EXIF-sourced (matches the Capture screen).
  addressSource?: "exif" | "live_gps";
  width?: number;
  height?: number;
}

export interface ScorecardDraft {
  id: string;
  clientSubmissionId: string; // stable across retries → idempotent submit
  dealId: string;
  dealName: string;
  projectNumber: string | null;
  weekOf: string; // yyyy-mm-dd
  superintendentName: string;
  pmName: string;
  scores: Partial<Record<ScorecardSectionKey, number>>;
  notes: Partial<Record<ScorecardSectionKey, string>>;
  photos: ScorecardDraftPhoto[];
  criticalDeficiencies: ScorecardCriticalDeficiencyKey[];
  actionItems: string[];
  createdAt: number;
  updatedAt: number;
}

export type DraftAction =
  | { type: "setScore"; sectionKey: ScorecardSectionKey; points: number }
  | { type: "setNote"; sectionKey: ScorecardSectionKey; note: string }
  | { type: "appendNote"; sectionKey: ScorecardSectionKey; text: string }
  | { type: "setHeader"; field: "superintendentName" | "pmName" | "weekOf"; value: string }
  | { type: "toggleDeficiency"; key: ScorecardCriticalDeficiencyKey }
  | { type: "setActionItems"; items: string[] }
  | { type: "appendActionItem"; text: string }
  | { type: "addPhoto"; photo: ScorecardDraftPhoto }
  | { type: "removePhoto"; key: string }
  | { type: "setPhotoCaption"; key: string; caption: string };

export interface ScorecardSubmissionPayload {
  clientSubmissionId: string;
  dealId: string;
  weekOf: string;
  superintendentName: string | null;
  pmName: string | null;
  items: { sectionKey: ScorecardSectionKey; points: number; note: string | null }[];
  criticalDeficiencies: string[];
  actionItems: string[];
  photos: { sectionKey: ScorecardSectionKey; clientUploadId: string }[];
}

export function createScorecardDraft(input: {
  id: string;
  clientSubmissionId: string;
  dealId: string;
  dealName: string;
  projectNumber: string | null;
  weekOf: string;
  now: number;
  superintendentName?: string;
  pmName?: string;
}): ScorecardDraft {
  return {
    id: input.id,
    clientSubmissionId: input.clientSubmissionId,
    dealId: input.dealId,
    dealName: input.dealName,
    projectNumber: input.projectNumber,
    weekOf: input.weekOf,
    superintendentName: input.superintendentName ?? "",
    pmName: input.pmName ?? "",
    scores: {},
    notes: {},
    photos: [],
    criticalDeficiencies: [],
    actionItems: [],
    createdAt: input.now,
    updatedAt: input.now,
  };
}

export function scorecardDraftReducer(draft: ScorecardDraft, action: DraftAction): ScorecardDraft {
  switch (action.type) {
    case "setScore":
      return { ...draft, scores: { ...draft.scores, [action.sectionKey]: action.points } };
    case "setNote":
      return { ...draft, notes: { ...draft.notes, [action.sectionKey]: action.note } };
    case "appendNote": {
      // Append to the LATEST note (from reducer state), so a dictation transcript that returns after the
      // user kept typing doesn't clobber those edits with a stale-closure value.
      const current = draft.notes[action.sectionKey] ?? "";
      const next = current ? `${current} ${action.text}` : action.text;
      return { ...draft, notes: { ...draft.notes, [action.sectionKey]: next } };
    }
    case "setHeader":
      return { ...draft, [action.field]: action.value };
    case "toggleDeficiency": {
      const has = draft.criticalDeficiencies.includes(action.key);
      return {
        ...draft,
        criticalDeficiencies: has
          ? draft.criticalDeficiencies.filter((k) => k !== action.key)
          : [...draft.criticalDeficiencies, action.key],
      };
    }
    case "setActionItems":
      return { ...draft, actionItems: action.items };
    case "appendActionItem": {
      // Append a dictated transcript as its own action item (from reducer state → no stale-closure
      // clobber, like appendNote). Drop trailing blank lines first so a mid-typed newline doesn't leave a
      // gap; ignore an empty transcript.
      const t = action.text.trim();
      if (!t) return draft;
      const items = [...draft.actionItems];
      while (items.length > 0 && items[items.length - 1].trim() === "") items.pop();
      return { ...draft, actionItems: [...items, t] };
    }
    case "addPhoto":
      return { ...draft, photos: [...draft.photos, action.photo] };
    case "removePhoto":
      return { ...draft, photos: draft.photos.filter((p) => p.key !== action.key) };
    case "setPhotoCaption":
      return {
        ...draft,
        photos: draft.photos.map((p) => (p.key === action.key ? { ...p, caption: action.caption } : p)),
      };
    default: {
      // Exhaustiveness guard: adding a DraftAction variant without a case here fails to compile.
      const _exhaustive: never = action;
      void _exhaustive;
      return draft;
    }
  }
}

// ── selectors ─────────────────────────────────────────────────────────────

export function scorecardDraftTotal(draft: ScorecardDraft): number {
  return FIELD_SCORECARD_SECTION_KEYS.reduce((sum, k) => sum + (draft.scores[k] ?? 0), 0);
}

export function scorecardDraftSectionsAnswered(draft: ScorecardDraft): number {
  return FIELD_SCORECARD_SECTION_KEYS.filter((k) => typeof draft.scores[k] === "number").length;
}

export function isScorecardDraftComplete(draft: ScorecardDraft): boolean {
  return FIELD_SCORECARD_SECTION_KEYS.every((k) => typeof draft.scores[k] === "number");
}

export function scorecardDraftRating(draft: ScorecardDraft): ScorecardRating {
  return resolveScorecardRating(scorecardDraftTotal(draft));
}

export function scorecardActionItemsRequired(draft: ScorecardDraft): boolean {
  return actionItemsRequired({
    total: scorecardDraftTotal(draft),
    deficiencyCount: draft.criticalDeficiencies.length,
  });
}

export function scorecardDraftPhotosForSection(
  draft: ScorecardDraft,
  sectionKey: ScorecardSectionKey,
): ScorecardDraftPhoto[] {
  return draft.photos.filter((p) => p.sectionKey === sectionKey);
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
/** A real YYYY-MM-DD calendar date — mirrors the server (rejects 2026-2-3, 2026-02-30, etc.). */
export function isValidWeekOf(weekOf: string): boolean {
  const v = weekOf.trim();
  if (!ISO_DATE.test(v)) return false;
  const [y, mo, d] = v.split("-").map(Number);
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d;
}

export interface DraftValidation {
  canSubmit: boolean;
  missingSections: ScorecardSectionKey[];
  needsActionItems: boolean;
  missingWeekOf: boolean; // true when Week Of is blank OR not a real calendar date
}
export function validateScorecardDraft(draft: ScorecardDraft): DraftValidation {
  const missingSections = FIELD_SCORECARD_SECTION_KEYS.filter((k) => typeof draft.scores[k] !== "number");
  const hasActionItem = draft.actionItems.some((s) => s.trim().length > 0);
  const needsActionItems = scorecardActionItemsRequired(draft) && !hasActionItem;
  const missingWeekOf = !isValidWeekOf(draft.weekOf);
  return {
    missingSections,
    needsActionItems,
    missingWeekOf,
    canSubmit: missingSections.length === 0 && !needsActionItems && !missingWeekOf && draft.dealId.length > 0,
  };
}

/** Build the POST /field/scorecards payload. Call only when validateScorecardDraft().canSubmit. */
export function scorecardDraftToSubmission(draft: ScorecardDraft): ScorecardSubmissionPayload {
  return {
    clientSubmissionId: draft.clientSubmissionId,
    dealId: draft.dealId,
    weekOf: draft.weekOf,
    superintendentName: draft.superintendentName.trim() || null,
    pmName: draft.pmName.trim() || null,
    items: FIELD_SCORECARD_SECTION_KEYS.map((k) => ({
      sectionKey: k,
      points: draft.scores[k] ?? 0,
      note: draft.notes[k]?.trim() ? draft.notes[k]!.trim() : null,
    })),
    criticalDeficiencies: [...draft.criticalDeficiencies],
    actionItems: draft.actionItems.map((s) => s.trim()).filter((s) => s.length > 0),
    photos: draft.photos.map((p) => ({ sectionKey: p.sectionKey, clientUploadId: p.clientUploadId })),
  };
}
