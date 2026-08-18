// Pure state engine for the weekly-report wizard: a serializable draft + a reducer + derived selectors.
// No React, no native I/O, no Date.now — the draft-store stamps updatedAt on persist and the wizard drives
// it via useReducer. Mirrors scorecards/draft.ts, and for the same reason: kept pure so it is unit-testable
// in a suite CI does not run, which is the only automated coverage `mobile/` gets.

import type { WeeklyReportPhotoCandidate, WeeklyReportStatusValue } from "../api/types";

/** The wizard's steps, in the order the design lays them out. */
export const WEEKLY_REPORT_STEPS = ["work", "lookahead", "issues", "numbers", "photos", "review"] as const;
export type WeeklyReportStep = (typeof WEEKLY_REPORT_STEPS)[number];

/** Mirrors the server's MAX_REPORT_PHOTOS. Enforced here so the cap is hit at selection, not at submit. */
export const MAX_WEEKLY_REPORT_PHOTOS = 60;
/** Mirrors MAX_CAPTION_CHARS. */
export const MAX_WEEKLY_REPORT_CAPTION_CHARS = 500;
/** Mirrors MAX_SECTION_CHARS — a runaway dictation loop, not a limit on anyone writing prose. */
export const MAX_WEEKLY_REPORT_SECTION_CHARS = 20_000;

/** The three dictatable prose sections, keyed as they are on the wire. */
export type WeeklyReportSectionKey = "workCompleted" | "nextWeekLookAhead" | "issuesConcerns";

export type WeeklyReportDraftPhoto = {
  /**
   * Stable local list key. A gallery photo uses its fileId; an import uses its clientUploadId, which it
   * keeps even after the upload assigns a fileId — so a re-render mid-upload cannot renumber the list or
   * make `removePhoto(key)` hit a different photo than the one that was tapped.
   */
  key: string;
  /** Set once the photo exists as a `files` row: immediately for a gallery photo, after upload for an import. */
  fileId: string | null;
  /** REPORT-SPECIFIC. Seeded from the capture description; editing it never writes back to the file. */
  caption: string;
  /** What the caption was seeded from, so the UI can show where it came from. */
  originalDescription: string | null;
  /** Presigned preview URL. Expires (6h), so it is refreshed from the server on every load. */
  remoteUrl: string | null;
  /**
   * Durable per-draft copy of an IMPORTED photo. Preferred over `remoteUrl` for preview because it never
   * expires, and draft-store rebases it onto the live document directory so a rotated iOS container heals.
   */
  localUri: string | null;
  /** Set for an import: the upload idempotency key, so a retry returns the existing file rather than a copy. */
  clientUploadId?: string;
  takenAt: string | null;
  /** Capture provenance, carried so the upload records the real shot time/place rather than the import's. */
  width?: number;
  height?: number;
  latitude?: number;
  longitude?: number;
  addressSource?: "exif" | "live_gps";
};

export interface WeeklyReportDraft {
  /** Local draft id. Also names the draft's photo directory, so it must never be reused. */
  id: string;
  /** Stamped ONCE at creation and reused on every retry — the server's idempotency key for the week. */
  clientSubmissionId: string;
  weeklyReportProjectId: string;
  /** The server report id, once one exists. Null until the first successful create. */
  reportId: string | null;
  dealId: string;
  projectName: string;
  /** yyyy-mm-dd, always a real cadence date for this project (the hub only offers those). */
  weekOf: string;
  /**
   * `author` is the superintendent writing it; `review` is the PM opening a submitted one. The only
   * differences are the wizard's title and which transition the final button fires — everything the two
   * modes are allowed to change is decided server-side, and shipped back as `permissions`.
   */
  mode: "author" | "review";
  /**
   * The status the server last reported for this report, or null when no report exists yet.
   *
   * Carried because the ladder has no self-transition: asking to move an already-`approved` report to
   * `approved` is a 409, so the final button has to know it should only SAVE. Refreshed whenever the draft
   * is seeded from a server read; a local draft never advances it on its own.
   */
  serverStatus: WeeklyReportStatusValue | null;
  step: WeeklyReportStep;
  workCompleted: string;
  nextWeekLookAhead: string;
  issuesConcerns: string;
  /**
   * Held as TEXT, not a number. A number field would round-trip a half-typed "1." to 1 on every keystroke
   * and make the decimal point untypeable; the parse happens once, on the way to the server.
   */
  completionPercent: string;
  weatherDelayDays: string;
  photos: WeeklyReportDraftPhoto[];
  createdAt: number;
  updatedAt: number;
}

/**
 * Seed a local draft from a report that already exists on the server.
 *
 * Used both when a superintendent resumes a week they started on another device and when a PM opens one
 * for review. `clientSubmissionId` still gets a fresh value even though the report exists: it is only ever
 * consulted by `POST /reports`, which this draft will never call, and inventing one here keeps the type
 * honest rather than carrying a nullable key that must be checked at every use.
 *
 * Photos arrive already ordered by `sort_order`, and their `caption` is the REPORT's caption — the server
 * seeded it from the capture description on first selection and has not written back to the file since.
 */
export function weeklyReportDraftFromDetail(input: {
  id: string;
  clientSubmissionId: string;
  projectName: string;
  mode: "author" | "review";
  report: {
    id: string;
    weeklyReportProjectId: string;
    dealId: string;
    weekOf: string;
    status: WeeklyReportStatusValue;
    workCompleted: string | null;
    nextWeekLookAhead: string | null;
    issuesConcerns: string | null;
    completionPercent: number | null;
    weatherDelayDays: number | null;
    photos: Array<{
      fileId: string;
      caption: string | null;
      originalDescription: string | null;
      takenAt: string | null;
      thumbnailUrl: string | null;
    }>;
  };
  now: number;
}): WeeklyReportDraft {
  const { report } = input;
  return {
    id: input.id,
    clientSubmissionId: input.clientSubmissionId,
    weeklyReportProjectId: report.weeklyReportProjectId,
    reportId: report.id,
    dealId: report.dealId,
    projectName: input.projectName,
    weekOf: report.weekOf,
    mode: input.mode,
    serverStatus: report.status,
    step: "work",
    workCompleted: report.workCompleted ?? "",
    nextWeekLookAhead: report.nextWeekLookAhead ?? "",
    issuesConcerns: report.issuesConcerns ?? "",
    completionPercent: report.completionPercent == null ? "" : String(report.completionPercent),
    weatherDelayDays: report.weatherDelayDays == null ? "" : String(report.weatherDelayDays),
    photos: report.photos.map((photo) => ({
      key: photo.fileId,
      fileId: photo.fileId,
      caption: photo.caption ?? "",
      originalDescription: photo.originalDescription,
      remoteUrl: photo.thumbnailUrl,
      localUri: null,
      takenAt: photo.takenAt,
    })),
    createdAt: input.now,
    updatedAt: input.now,
  };
}

export type WeeklyReportDraftAction =
  | { type: "setSection"; key: WeeklyReportSectionKey; value: string }
  /** Dictation: appends to whatever is already there rather than replacing it. */
  | { type: "appendSection"; key: WeeklyReportSectionKey; text: string }
  | { type: "setNumber"; key: "completionPercent" | "weatherDelayDays"; value: string }
  | { type: "setStep"; step: WeeklyReportStep }
  | { type: "setReportId"; reportId: string }
  /** The server moved the report; record it so the final button stops asking for a transition it made. */
  | { type: "setServerStatus"; status: WeeklyReportStatusValue }
  | { type: "addPhoto"; photo: WeeklyReportDraftPhoto }
  | { type: "removePhoto"; key: string }
  | { type: "setPhotoCaption"; key: string; caption: string }
  | { type: "appendPhotoCaption"; key: string; text: string }
  | { type: "movePhoto"; key: string; direction: -1 | 1 }
  /** An import finished uploading: it now has a `files` row and a fresh preview URL. */
  | { type: "resolvePhotoUpload"; key: string; fileId: string; remoteUrl: string | null }
  /** Refresh expired preview URLs from a server read, keyed by fileId. */
  | { type: "refreshPhotoUrls"; urlsByFileId: Record<string, string | null> }
  | { type: "replaceDraft"; draft: WeeklyReportDraft };

export function createWeeklyReportDraft(input: {
  id: string;
  clientSubmissionId: string;
  weeklyReportProjectId: string;
  dealId: string;
  projectName: string;
  weekOf: string;
  mode?: "author" | "review";
  reportId?: string | null;
  /** Last week's numbers. Prefilled so step 5 is a nudge rather than re-entry. */
  completionPercent?: number | null;
  weatherDelayDays?: number | null;
  now: number;
}): WeeklyReportDraft {
  return {
    id: input.id,
    clientSubmissionId: input.clientSubmissionId,
    weeklyReportProjectId: input.weeklyReportProjectId,
    reportId: input.reportId ?? null,
    dealId: input.dealId,
    projectName: input.projectName,
    weekOf: input.weekOf,
    mode: input.mode ?? "author",
    serverStatus: null,
    step: "work",
    workCompleted: "",
    nextWeekLookAhead: "",
    issuesConcerns: "",
    completionPercent: input.completionPercent == null ? "" : String(input.completionPercent),
    weatherDelayDays: input.weatherDelayDays == null ? "" : String(input.weatherDelayDays),
    photos: [],
    createdAt: input.now,
    updatedAt: input.now,
  };
}

function appendText(existing: string, text: string, limit: number): string {
  const addition = text.trim();
  if (!addition) return existing;
  const base = existing.trimEnd();
  // Dictation appends programmatically, so a TextInput's maxLength never applies — cap here or a long
  // dictated section silently overruns what the server will accept and the PATCH 400s at submit.
  return (base ? `${base}\n${addition}` : addition).slice(0, limit);
}

function mapPhoto(
  draft: WeeklyReportDraft,
  key: string,
  update: (photo: WeeklyReportDraftPhoto) => WeeklyReportDraftPhoto,
): WeeklyReportDraft {
  let changed = false;
  const photos = draft.photos.map((photo) => {
    if (photo.key !== key) return photo;
    changed = true;
    return update(photo);
  });
  return changed ? { ...draft, photos } : draft;
}

export function weeklyReportDraftReducer(
  draft: WeeklyReportDraft,
  action: WeeklyReportDraftAction,
): WeeklyReportDraft {
  switch (action.type) {
    case "setSection":
      return { ...draft, [action.key]: action.value.slice(0, MAX_WEEKLY_REPORT_SECTION_CHARS) };
    case "appendSection":
      return {
        ...draft,
        [action.key]: appendText(draft[action.key], action.text, MAX_WEEKLY_REPORT_SECTION_CHARS),
      };
    case "setNumber":
      return { ...draft, [action.key]: action.value };
    case "setStep":
      return { ...draft, step: action.step };
    case "setReportId":
      return { ...draft, reportId: action.reportId };
    case "setServerStatus":
      return { ...draft, serverStatus: action.status };
    case "addPhoto":
      // Idempotent on key so a double-tap on a candidate tile cannot add it twice — the server rejects a
      // duplicated fileId outright, which would surface as a failed submit long after the tap.
      if (draft.photos.some((photo) => photo.key === action.photo.key)) return draft;
      if (draft.photos.length >= MAX_WEEKLY_REPORT_PHOTOS) return draft;
      return { ...draft, photos: [...draft.photos, action.photo] };
    case "removePhoto":
      return { ...draft, photos: draft.photos.filter((photo) => photo.key !== action.key) };
    case "setPhotoCaption":
      return mapPhoto(draft, action.key, (photo) => ({
        ...photo,
        caption: action.caption.slice(0, MAX_WEEKLY_REPORT_CAPTION_CHARS),
      }));
    case "appendPhotoCaption":
      return mapPhoto(draft, action.key, (photo) => ({
        ...photo,
        caption: appendText(photo.caption, action.text, MAX_WEEKLY_REPORT_CAPTION_CHARS),
      }));
    case "movePhoto": {
      const index = draft.photos.findIndex((photo) => photo.key === action.key);
      if (index < 0) return draft;
      const nextIndex = index + action.direction;
      // A no-op at the ends rather than a wrap; the controls are disabled there anyway.
      if (nextIndex < 0 || nextIndex >= draft.photos.length) return draft;
      const photos = [...draft.photos];
      const [moved] = photos.splice(index, 1);
      photos.splice(nextIndex, 0, moved);
      return { ...draft, photos };
    }
    case "resolvePhotoUpload":
      return mapPhoto(draft, action.key, (photo) => ({
        ...photo,
        fileId: action.fileId,
        remoteUrl: action.remoteUrl ?? photo.remoteUrl,
      }));
    case "refreshPhotoUrls": {
      let changed = false;
      const photos = draft.photos.map((photo) => {
        if (!photo.fileId) return photo;
        const url = action.urlsByFileId[photo.fileId];
        // `undefined` means the read did not cover this photo — leave the existing (possibly stale) url
        // alone rather than blanking a thumbnail that still renders. An explicit null DOES clear it.
        if (url === undefined || url === photo.remoteUrl) return photo;
        changed = true;
        return { ...photo, remoteUrl: url };
      });
      return changed ? { ...draft, photos } : draft;
    }
    case "replaceDraft":
      return action.draft;
    default:
      return draft;
  }
}

// ── Selectors ────────────────────────────────────────────────────────────────

/** What to render for a photo: the durable local copy first, because a presigned URL expires. */
export function weeklyReportPhotoPreviewUri(photo: WeeklyReportDraftPhoto): string | null {
  return photo.localUri ?? photo.remoteUrl;
}

/**
 * The picker's grid: the server's candidate window, plus any selected photo it does not contain.
 *
 * The header counts `draft.photos`, the grid renders candidates, and nothing guaranteed the two agreed.
 * Two ways they came apart, both of them leaving a photo counted as selected with no tick anywhere on
 * screen and no way to deselect it:
 *
 *   • the window is CAPPED newest-first, so a photo picked from the far end of it drops out as soon as
 *     enough newer ones exist (the server now protects a photo already saved on the report, but a
 *     selection that has not been PUT yet is only known here);
 *   • an import carries the shot's own EXIF time, so it can land outside the window entirely.
 *
 * Appended rather than merged in place: the list is newest-first and these are, by construction, the
 * oldest — or not in the window's ordering at all.
 */
export function weeklyReportPickerCandidates(
  candidates: readonly WeeklyReportPhotoCandidate[],
  photos: readonly WeeklyReportDraftPhoto[],
): WeeklyReportPhotoCandidate[] {
  const present = new Set(candidates.map((candidate) => candidate.fileId));
  const merged: WeeklyReportPhotoCandidate[] = [...candidates];
  for (const photo of photos) {
    // A photo still uploading has no fileId and no server identity yet; it is shown on the arrange step,
    // never in this grid.
    if (!photo.fileId || present.has(photo.fileId)) continue;
    present.add(photo.fileId);
    merged.push({
      fileId: photo.fileId,
      caption: photo.caption || null,
      originalDescription: photo.originalDescription,
      sortOrder: 0,
      takenAt: photo.takenAt,
      mimeType: null,
      thumbnailUrl: weeklyReportPhotoPreviewUri(photo),
      fullUrl: null,
      alreadyUsedOn: null,
      selected: true,
    });
  }
  return merged;
}

/**
 * Parse the completion field for the wire. Returns `undefined` for a value the server would reject, so
 * the caller can block submit rather than send a 400.
 */
export function parseWeeklyReportPercent(value: string): number | null | undefined {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 100) return undefined;
  // Two decimals, matching the column's numeric(5,2), so the value echoed back is the value stored.
  return Math.round(parsed * 100) / 100;
}

/** Same contract as `parseWeeklyReportPercent`, for the whole-days weather-delay field. */
export function parseWeeklyReportDelayDays(value: string): number | null | undefined {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const parsed = Number(trimmed);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 3650) return undefined;
  return parsed;
}

export type WeeklyReportContentPatch = {
  workCompleted: string | null;
  nextWeekLookAhead: string | null;
  issuesConcerns: string | null;
  completionPercent: number | null;
  weatherDelayDays: number | null;
};

/**
 * The PATCH body. Every field is sent, including the empty ones as explicit nulls: the local draft is the
 * authoritative copy of what the user typed, so a section they CLEARED must clear on the server too. An
 * omitted key would leave the previous text in place and the report would print something the author
 * deliberately deleted.
 *
 * Returns null when a number field is unparseable — the caller blocks submit instead of sending a 400.
 */
export function weeklyReportDraftToPatch(draft: WeeklyReportDraft): WeeklyReportContentPatch | null {
  const completionPercent = parseWeeklyReportPercent(draft.completionPercent);
  const weatherDelayDays = parseWeeklyReportDelayDays(draft.weatherDelayDays);
  if (completionPercent === undefined || weatherDelayDays === undefined) return null;
  return {
    workCompleted: draft.workCompleted.trim() || null,
    nextWeekLookAhead: draft.nextWeekLookAhead.trim() || null,
    issuesConcerns: draft.issuesConcerns.trim() || null,
    completionPercent,
    weatherDelayDays,
  };
}

/**
 * The photo payload, in the order the user arranged them — that order IS the print order.
 *
 * Photos still uploading are omitted rather than sent with a null id: including one would fail the whole
 * PUT and drop the entire selection. `weeklyReportDraftPendingUploads` is what blocks submit until they
 * land, so nothing is silently lost.
 */
export function weeklyReportDraftToPhotoPayload(
  draft: WeeklyReportDraft,
): Array<{ fileId: string; caption: string | null }> {
  return draft.photos
    .filter((photo): photo is WeeklyReportDraftPhoto & { fileId: string } => Boolean(photo.fileId))
    .map((photo) => ({ fileId: photo.fileId, caption: photo.caption.trim() || null }));
}

/**
 * Imported photos whose upload has not produced a `files` row yet. Non-empty ⇒ submit is blocked.
 *
 * "Not uploaded yet" and "failed to upload" are indistinguishable from here — both are simply a photo
 * with no `fileId` — which is why the wizard offers a RETRY rather than telling the user to wait. A
 * failed upload is not transient on its own: nothing re-drives it, so without the retry this predicate
 * blocks the report forever and the only escape is deleting the photos.
 */
export function weeklyReportDraftPendingUploads(draft: WeeklyReportDraft): WeeklyReportDraftPhoto[] {
  return draft.photos.filter((photo) => !photo.fileId);
}

/** True when a photo came from the device rather than the project gallery (it owns a durable local copy). */
export function isImportedWeeklyReportPhoto(photo: WeeklyReportDraftPhoto): boolean {
  return Boolean(photo.clientUploadId);
}

/**
 * Why the draft cannot be submitted yet, or null when it can.
 *
 * `workCompleted` mirrors the server's own submit gate (`transitionWeeklyReport` refuses an empty report
 * into the PM's queue); catching it here means the user is told at the section they need to fill in
 * rather than at the end of the wizard.
 */
export function weeklyReportDraftBlocker(draft: WeeklyReportDraft): string | null {
  if (!draft.workCompleted.trim()) return "Add what was completed this week before submitting.";
  if (parseWeeklyReportPercent(draft.completionPercent) === undefined) {
    return "Completion % must be a number between 0 and 100.";
  }
  if (parseWeeklyReportDelayDays(draft.weatherDelayDays) === undefined) {
    return "Weather delays must be a whole number of days.";
  }
  const pending = weeklyReportDraftPendingUploads(draft).length;
  if (pending > 0) {
    return `${pending} photo${pending === 1 ? " has" : "s have"} not uploaded — tap Retry uploads, or remove ${pending === 1 ? "it" : "them"}.`;
  }
  return null;
}

/** How far along the draft is, for the hub's resume row. */
export function weeklyReportDraftSectionsFilled(draft: WeeklyReportDraft): number {
  return [draft.workCompleted, draft.nextWeekLookAhead, draft.issuesConcerns].filter((s) => s.trim()).length;
}

export function weeklyReportStepIndex(step: WeeklyReportStep): number {
  const index = WEEKLY_REPORT_STEPS.indexOf(step);
  return index < 0 ? 0 : index;
}

export function weeklyReportStepAt(index: number): WeeklyReportStep {
  const clamped = Math.max(0, Math.min(index, WEEKLY_REPORT_STEPS.length - 1));
  return WEEKLY_REPORT_STEPS[clamped];
}
