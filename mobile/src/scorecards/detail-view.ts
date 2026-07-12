// Pure display helpers for the submitted-scorecard detail screen. No React/native imports so the
// mapping logic (the riskiest bits — deficiency key→label, PDF-404 handling) is unit-testable.
//
// The scoring model is sourced from ./scoring, the HAND-SYNCED mirror of shared/src/types/field-scorecard.ts.
// The Expo bundle can't import @trock-crm/shared; keep the mirror in sync (see scoring-mirror.test.ts).
import {
  FIELD_SCORECARD_SECTIONS,
  FIELD_SCORECARD_LEADERSHIP_SECTIONS,
  FIELD_SCORECARD_LEADERSHIP_SUMMARY_SECTION_KEY,
  FIELD_SCORECARD_CRITICAL_DEFICIENCIES,
  FIELD_SCORECARD_TOTAL_POINTS,
  type ScorecardSectionKey,
} from "./scoring";
import type { FieldScorecardItemView, FieldScorecardPhotoView } from "../api/types";

/** 0–100 max the detail summary is scored against (re-exported for the view header). */
export const SCORECARD_TOTAL_POINTS = FIELD_SCORECARD_TOTAL_POINTS;

const DEFICIENCY_LABEL: Record<string, string> = Object.fromEntries(
  FIELD_SCORECARD_CRITICAL_DEFICIENCIES.map((d) => [d.key, d.label]),
);

/**
 * Human label for a critical-deficiency KEY. The detail endpoint returns validated snake_case keys
 * (e.g. "missed_hold_point"), not labels; unknown keys pass through raw so a future server-added key
 * never renders blank. (The scoring-mirror content-snapshot test freezes this map against the shared
 * source so a rename in shared/ fails CI-local before it can strand a key at its raw form here.)
 */
export function deficiencyLabel(key: string): string {
  return DEFICIENCY_LABEL[key] ?? key;
}

export interface ScorecardSectionRow {
  key: ScorecardSectionKey;
  title: string;
  points: number;
  maxPoints: number;
  note: string | null;
}

/** Merge the detail's scored items with the canonical section defs, in canonical form order. */
export function scorecardSectionRows(items: readonly FieldScorecardItemView[]): ScorecardSectionRow[] {
  const itemByKey = new Map(items.map((i) => [i.sectionKey, i]));
  return FIELD_SCORECARD_SECTIONS.map((s) => {
    const item = itemByKey.get(s.key);
    return {
      key: s.key,
      title: s.title,
      points: item?.points ?? 0,
      maxPoints: 10,
      note: item?.note ?? null,
    };
  });
}

export interface ScorecardLeadershipRow {
  key: string;
  title: string;
  points: number;
  note: string | null;
}

/**
 * Merge a leadership card's scored items with the 4 canonical leadership category defs, in canonical order.
 * Each category is rated 1-10; a missing item shows 0. Mirrors scorecardSectionRows but for the leadership
 * sections (a distinct, disjoint key set) — the detail view branches on card kind to pick the right one.
 */
export function scorecardLeadershipRows(items: readonly FieldScorecardItemView[]): ScorecardLeadershipRow[] {
  const itemByKey = new Map(items.map((i) => [i.sectionKey, i]));
  return FIELD_SCORECARD_LEADERSHIP_SECTIONS.map((s) => {
    const item = itemByKey.get(s.key);
    return { key: s.key, title: s.title, points: item?.points ?? 0, note: item?.note ?? null };
  });
}

/** The Project Summary evidence photos on a leadership card (sectionKey `project_summary`), in order. */
export function scorecardSummaryPhotos(
  photos: readonly FieldScorecardPhotoView[],
): FieldScorecardPhotoView[] {
  return photos.filter((p) => p.sectionKey === FIELD_SCORECARD_LEADERSHIP_SUMMARY_SECTION_KEY);
}

export interface ScorecardPhotoSection {
  key: ScorecardSectionKey;
  title: string;
  photos: FieldScorecardPhotoView[];
}

const PROJECT_SECTION_KEYS = new Set<string>(FIELD_SCORECARD_SECTIONS.map((s) => s.key));
function isProjectSectionKey(key: string): key is ScorecardSectionKey {
  return PROJECT_SECTION_KEYS.has(key);
}

/** Group evidence photos under their section (canonical order); sections with no photos are dropped. */
export function scorecardPhotoSections(
  photos: readonly FieldScorecardPhotoView[],
): ScorecardPhotoSection[] {
  const byKey = new Map<ScorecardSectionKey, FieldScorecardPhotoView[]>();
  for (const p of photos) {
    // Only project section keys group here; deficiency evidence and leadership `project_summary` photos are
    // excluded (leadership photos render via scorecardSummaryPhotos instead).
    if (!isProjectSectionKey(p.sectionKey)) continue;
    const list = byKey.get(p.sectionKey) ?? [];
    list.push(p);
    byKey.set(p.sectionKey, list);
  }
  const out: ScorecardPhotoSection[] = [];
  for (const s of FIELD_SCORECARD_SECTIONS) {
    const list = byKey.get(s.key);
    if (list && list.length > 0) out.push({ key: s.key, title: s.title, photos: list });
  }
  return out;
}

/**
 * Toast copy for a failed PDF download. The one /download endpoint 404s for THREE distinct server
 * causes, each with its own message:
 *   - "The scorecard PDF is still generating — please try again shortly." (pdf_r2_key null — the common case)
 *   - "Scorecard not found"  (row gone)
 *   - "Project not found"    (assertActiveFieldProject — the deal went terminal after the screen loaded)
 * The mobile client copies the server's error text into ApiError.message (client.ts), so PREFER that
 * text when it's a real ApiError message (has a numeric status and isn't the generic transport default
 * "Request failed (N)"). Otherwise fall back by status: a bare 404 → still-generating; anything else →
 * a neutral open-failure line. Duck-typed on `status`/`message` so it needs no ApiError import.
 */
export function scorecardDownloadErrorMessage(err: unknown): string {
  const e = err as { status?: unknown; message?: unknown } | null | undefined;
  const status = typeof e?.status === "number" ? e.status : undefined;
  const message = typeof e?.message === "string" ? e.message : "";
  if (status !== undefined && message && !message.startsWith("Request failed")) {
    return message;
  }
  if (status === 404) {
    return "The scorecard PDF is still generating — try again in a moment.";
  }
  return "Couldn't open the scorecard PDF.";
}

/** "Mon D" from a yyyy-mm-dd week value (parsed LOCAL, no UTC drift) or an ISO timestamp. */
export function formatShortDate(value: string): string {
  const d = new Date(value.length === 10 ? `${value}T00:00:00` : value);
  return Number.isNaN(d.getTime())
    ? value
    : d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}
