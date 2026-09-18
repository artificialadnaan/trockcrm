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

/**
 * The server state a local draft was last RECONCILED against.
 *
 * Provenance, not a cache. Without it the app cannot tell "the server has not moved since I seeded this
 * draft" from "somebody rewrote the report while I held it", and every re-read has to guess — reseeding
 * blindly throws away un-submitted local edits, and NOT reseeding files a stale snapshot over somebody
 * else's work. Both of those shipped. Holding the status AND a content fingerprint answers both questions:
 *
 *   local edits  ⟺ signature(draft)  ≠ seededFrom.signature
 *   server moved ⟺ signature(server) ≠ seededFrom.signature  or  status differs
 *
 * Updated whenever the draft is seeded from a read, adopts a server row, or the user resolves a conflict —
 * i.e. it always names the server state the user has actually been shown.
 */
export interface WeeklyReportSeedState {
  status: WeeklyReportStatusValue;
  signature: string;
}

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
  /**
   * The server state this draft was last reconciled against, or null when it has never corresponded to a
   * server row. Null is read as "an empty report in `draft`", which is exactly what a row created by
   * `POST /reports` holds — so a purely local draft and a freshly created row compare equal.
   */
  seededFrom: WeeklyReportSeedState | null;
  /**
   * A transition this client FIRED and never learned the outcome of.
   *
   * The only thing that can tell "my own move committed and the reply was lost" (a success) apart from
   * "somebody else advanced this report" (emphatically not one — this client's PATCH and photo PUT just
   * landed on top of their work). Persisted with the draft because the two attempts are usually separated
   * by a lost connection, an app kill, or both.
   */
  pendingTransitionTo: WeeklyReportStatusValue | null;
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

/** The subset of a draft that a submit actually WRITES — everything the fingerprint is taken over. */
export interface WeeklyReportSignableContent {
  workCompleted: string;
  nextWeekLookAhead: string;
  issuesConcerns: string;
  completionPercent: string;
  weatherDelayDays: string;
  photos: readonly Pick<WeeklyReportDraftPhoto, "key" | "fileId" | "caption">[];
}

/**
 * A stable fingerprint of everything a submit would send: the three sections, the two numbers, and the
 * photo set IN ORDER with its captions. Order is part of it because order is the print order.
 *
 * `remoteUrl` is deliberately excluded. Presigned previews are re-issued on every read, so folding them in
 * would make an untouched report look changed on every single re-read and turn the conflict prompt into
 * noise nobody reads. `step`, `updatedAt`, `originalDescription` and the ids are out for the same reason:
 * none of them is content, and none of them reaches the PATCH or the photo PUT.
 *
 * Numbers go through the same parsers the PATCH uses, so "12.50" and "12.5" are one value rather than a
 * phantom edit. An unparseable number falls back to its trimmed text, which keeps the function total.
 *
 * A photo still uploading has no fileId, so it is keyed by its local key — an imported photo IS a local
 * edit even before it has a server identity.
 */
export function weeklyReportContentSignature(content: WeeklyReportSignableContent): string {
  const percent = parseWeeklyReportPercent(content.completionPercent);
  const delay = parseWeeklyReportDelayDays(content.weatherDelayDays);
  return JSON.stringify([
    content.workCompleted.trim(),
    content.nextWeekLookAhead.trim(),
    content.issuesConcerns.trim(),
    percent === undefined ? content.completionPercent.trim() : percent,
    delay === undefined ? content.weatherDelayDays.trim() : delay,
    content.photos.map((photo) => [photo.fileId ?? `local:${photo.key}`, photo.caption.trim()]),
  ]);
}

export function weeklyReportDraftSignature(draft: WeeklyReportDraft): string {
  return weeklyReportContentSignature(draft);
}

/**
 * What a report holds the moment `POST /reports` creates its row: nothing.
 *
 * This is the baseline a draft with no `seededFrom` is compared against — a local draft that has never
 * been near the server, and a row just created for it, are the same empty report.
 */
export const WEEKLY_REPORT_EMPTY_SIGNATURE = weeklyReportContentSignature({
  workCompleted: "",
  nextWeekLookAhead: "",
  issuesConcerns: "",
  completionPercent: "",
  weatherDelayDays: "",
  photos: [],
});

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
/** The server payload a draft can be seeded from — `WeeklyReportDetailView`, reduced to what is read. */
export interface WeeklyReportSeedableReport {
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
}

export function weeklyReportDraftFromDetail(input: {
  id: string;
  clientSubmissionId: string;
  projectName: string;
  mode: "author" | "review";
  report: WeeklyReportSeedableReport;
  now: number;
}): WeeklyReportDraft {
  const { report } = input;
  const seeded: WeeklyReportDraft = {
    id: input.id,
    clientSubmissionId: input.clientSubmissionId,
    weeklyReportProjectId: report.weeklyReportProjectId,
    reportId: report.id,
    dealId: report.dealId,
    projectName: input.projectName,
    weekOf: report.weekOf,
    mode: input.mode,
    serverStatus: report.status,
    seededFrom: null,
    pendingTransitionTo: null,
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
  // Signed from the SEEDED DRAFT rather than from the payload, so the "what the server holds" fingerprint
  // and the "what I hold" fingerprint can never be computed by two functions that drift apart.
  return {
    ...seeded,
    seededFrom: { status: report.status, signature: weeklyReportDraftSignature(seeded) },
  };
}

/**
 * The provenance stamp for a report the server just handed back, without building a whole draft.
 *
 * Routed through `weeklyReportDraftFromDetail` rather than reading the payload a second time, so the
 * "what the server holds" fingerprint is produced by exactly one mapping. A second copy of that mapping
 * would drift the first time a field is added, and the symptom would be a conflict prompt on every open.
 */
export function weeklyReportSeedStateFromDetail(report: WeeklyReportSeedableReport): WeeklyReportSeedState {
  const seeded = weeklyReportDraftFromDetail({
    id: "",
    clientSubmissionId: "",
    projectName: "",
    mode: "author",
    report,
    now: 0,
  });
  return { status: report.status, signature: weeklyReportDraftSignature(seeded) };
}

export type WeeklyReportDraftAction =
  | { type: "setSection"; key: WeeklyReportSectionKey; value: string }
  /** Dictation: appends to whatever is already there rather than replacing it. */
  | { type: "appendSection"; key: WeeklyReportSectionKey; text: string }
  | { type: "setNumber"; key: "completionPercent" | "weatherDelayDays"; value: string }
  | { type: "setStep"; step: WeeklyReportStep }
  /**
   * A server row now backs this draft. `seededFrom` travels with it: a row this draft CREATED is empty,
   * a row it ADOPTED is not, and the difference is what every later freshness check reads.
   */
  | { type: "setReportId"; reportId: string; seededFrom?: WeeklyReportSeedState | null }
  /**
   * Re-stamp the provenance from a write the SERVER acknowledged, leaving the content alone.
   *
   * Submit is three requests and only the last one files the report, so the middle of that sequence is a
   * state the phone regularly lives in: the PATCH lands and the photo PUT does not, or both land and the
   * transition does not. Without re-stamping, `seededFrom` still describes the row as it was BEFORE the
   * submit, so the next open sees "the server moved" and "I have local edits" and raises a two-way
   * conflict dialog naming a colleague who does not exist — whose destructive button then drops the
   * photos this phone had just successfully uploaded.
   */
  /**
   * The server has permanently retired this draft's submission key, so give it a new one.
   *
   * `weekly_reports_client_submission_id_key` is a plain UNIQUE constraint, not a partial one: once the
   * report a phone created is DELETED, that key can never produce a row again and every retry gets the
   * same 409 for the rest of time. The writing on the draft is untouched by any of that — only its key
   * is spent — so the recovery is a fresh key over the same words, and the alternative the field user
   * had was discarding a week's work and starting again on a jobsite.
   *
   * The report id, provenance, lifecycle status and lost-transition marker go WITH the row. A replacement
   * is a new AUTHOR draft, not the deleted row wearing a new id: retaining `approved` would turn its final
   * action into "Save changes" and leave the new row unfiled, while retaining a marker could call somebody
   * else's replacement transition this phone's own lost reply. `ensureReport` also short-circuits on
   * `reportId`, so leaving that dead id behind would hand back the deleted row forever.
   */
  | { type: "renewClientSubmissionId"; clientSubmissionId: string }
  | { type: "setSeededFrom"; seededFrom: WeeklyReportSeedState | null }
  /** The server moved the report; record it so the final button stops asking for a transition it made. */
  | { type: "setServerStatus"; status: WeeklyReportStatusValue }
  /** Arm (or disarm) the "I fired this transition and never heard back" marker. */
  | { type: "setPendingTransition"; to: WeeklyReportStatusValue | null }
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
    // Never been near the server. Read as "an empty report in `draft`" wherever a baseline is needed.
    seededFrom: null,
    pendingTransitionTo: null,
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
      return {
        ...draft,
        reportId: action.reportId,
        // `undefined` means "leave the provenance alone"; an explicit null clears it.
        seededFrom: action.seededFrom === undefined ? draft.seededFrom : action.seededFrom,
      };
    case "renewClientSubmissionId":
      return {
        ...draft,
        clientSubmissionId: action.clientSubmissionId,
        // Row-bound state is cleared deliberately — see the action note. The writing stays exactly as it is.
        reportId: null,
        seededFrom: null,
        mode: "author",
        serverStatus: null,
        pendingTransitionTo: null,
      };
    case "setSeededFrom":
      return { ...draft, seededFrom: action.seededFrom };
    case "setServerStatus":
      return { ...draft, serverStatus: action.status };
    case "setPendingTransition":
      return { ...draft, pendingTransitionTo: action.to };
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

/**
 * Reconcile an autosave snapshot with a submission key that became durable after that snapshot rendered.
 *
 * React effects retain the draft from their render. A renewal deliberately waits for its own
 * read-modify-write before it dispatches, so an edit made while that write is pending can queue an
 * autosave carrying the RETIRED key behind it. Letting that snapshot write unchanged would erase the
 * durable replacement key in the narrow window before the renewed render's autosave runs. Apply the
 * same reducer transition at save time: it preserves that later edit, but cannot resurrect identity or
 * lifecycle state belonging to the deleted row.
 */
export function weeklyReportDraftForAutosave(
  draft: WeeklyReportDraft,
  renewedClientSubmissionId: string | null,
): WeeklyReportDraft {
  if (!renewedClientSubmissionId || draft.clientSubmissionId === renewedClientSubmissionId) return draft;
  return weeklyReportDraftReducer(draft, {
    type: "renewClientSubmissionId",
    clientSubmissionId: renewedClientSubmissionId,
  });
}

/** Effects the wizard needs to serialize its whole-draft autosaves. Kept pure/native-free for race tests. */
export interface WeeklyReportAutosavePort {
  finalized(): boolean;
  /** Read when this save RUNS, not when the effect queues it. */
  renewedClientSubmissionId(): string | null;
  save(draft: WeeklyReportDraft): Promise<void>;
}

/**
 * Append a snapshot to the wizard's save chain without letting a renewal immediately ahead of it regress.
 *
 * The deferred `renewedClientSubmissionId` read is intentional and test-covered: this autosave may be
 * appended while the renewal is in flight, but its callback does not run until that renewal has made the
 * replacement key durable.
 */
export function enqueueWeeklyReportAutosave(
  saveChain: Promise<unknown>,
  draft: WeeklyReportDraft,
  port: WeeklyReportAutosavePort,
): Promise<unknown> {
  return saveChain
    .then(() => {
      if (port.finalized()) return;
      return port.save(weeklyReportDraftForAutosave(draft, port.renewedClientSubmissionId()));
    })
    .catch(() => undefined);
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
