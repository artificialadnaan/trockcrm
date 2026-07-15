// Pure state engine for the scorecard wizard: a serializable draft + a reducer + derived selectors.
// No React, no native I/O, no Date.now — the draft-store stamps updatedAt on persist and the wizard
// drives it via useReducer. Kept pure so it's unit-testable (and the CI-ungated mobile suite still runs it).

import {
  FIELD_SCORECARD_LEADERSHIP_SECTION_KEYS,
  FIELD_SCORECARD_LEADERSHIP_SUMMARY_SECTION_KEY,
  FIELD_SCORECARD_SECTION_KEYS,
  resolveScorecardRating,
  type ScorecardCriticalDeficiencyKey,
  type ScorecardKind,
  type ScorecardLeadershipSectionKey,
  type ScorecardRating,
  type ScorecardSectionKey,
} from "./scoring";

interface ScorecardDraftPhotoBase {
  key: string; // local list key
  // New evidence uses a durable per-draft file URI; retained evidence on an edit uses a short-lived
  // presigned remote URI which is refreshed from the scorecard detail whenever the editor resumes.
  uri: string;
  // Project cards attach photos per category (or to a critical_deficiency); leadership cards attach photos to
  // any leadership category or to the Project Summary (`project_summary`). One structure serves both flows.
  sectionKey: ScorecardSectionKey | ScorecardLeadershipSectionKey | "critical_deficiency" | typeof FIELD_SCORECARD_LEADERSHIP_SUMMARY_SECTION_KEY;
  deficiencyKey?: ScorecardCriticalDeficiencyKey;
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

/**
 * Evidence already linked to the submitted scorecard. It must never enter the durable upload queue: saving
 * an edit retains it by scorecard-photo id, while removing it only unlinks it from the scorecard.
 */
export type ExistingScorecardDraftPhoto = ScorecardDraftPhotoBase & {
  existingScorecardPhotoId: string;
  clientUploadId?: never;
};

/** New evidence captured/imported while composing either a new scorecard or an edit. */
export type NewScorecardDraftPhoto = ScorecardDraftPhotoBase & {
  existingScorecardPhotoId?: never;
  clientUploadId: string; // stamped at capture; resolved to a fileId server-side on submit/save
};

export type ScorecardDraftPhoto = ExistingScorecardDraftPhoto | NewScorecardDraftPhoto;

/** Server-enforced cap for evidence links on either scorecard kind. */
export const MAX_SCORECARD_PHOTOS = 100;

export interface ScorecardDraft {
  id: string;
  clientSubmissionId: string; // stable across retries → idempotent submit
  /**
   * Discriminates project (default) vs leadership scorecards; both share this draft + all the capture/
   * submit machinery. Optional so pre-leadership drafts resume without a migration (absent ⇒ 'project').
   */
  kind?: ScorecardKind;
  dealId: string;
  dealName: string;
  projectNumber: string | null;
  weekOf: string; // yyyy-mm-dd
  superintendentName: string;
  pmName: string;
  /**
   * Auto-recorded name of the submitting user (the Evaluator) — leadership only. Seeded from the current
   * user's name and shown READ-ONLY in the header (the Evaluator is whoever submits: the server stamps
   * submittedByName from the field user, which IS the evaluator). The project card has no evaluator field.
   */
  evaluatorName?: string;
  /** Present only for a persisted local edit of an already-submitted scorecard. */
  editingScorecardId?: string;
  /** Owning office for evidence uploads; edits can be opened from the cross-office submitted list. */
  editingOfficeId?: string | null;
  /** Optimistic-concurrency token returned by the detail endpoint. */
  editBaseUpdatedAt?: string;
  /**
   * Canonical editable-content snapshot for editBaseUpdatedAt. This excludes mutable gallery captions/URLs,
   * allowing a caption-only refresh to advance its evidence generation without masking a concurrent form edit.
   * Optional so drafts created before submitted-card editing shipped still load conservatively.
   */
  editBaseContentFingerprint?: string;
  /**
   * Retained evidence-link ids present at editBaseUpdatedAt. Conflict recovery compares this snapshot with
   * both the local desired links and the latest server links, so it can preserve concurrently-added evidence
   * without resurrecting evidence the local user intentionally removed.
   */
  editBasePhotoIds?: string[];
  /**
   * Critical-deficiency state present at editBaseUpdatedAt. Conflict recovery uses these as the base leg of a
   * three-way merge so local selection/note edits win, while genuine remote changes can still be surfaced for
   * review. Both are optional for pre-snapshot drafts, which rebase conservatively with local state winning.
   */
  editBaseCriticalDeficiencies?: ScorecardCriticalDeficiencyKey[];
  editBaseCriticalDeficiencyNotes?: Partial<Record<ScorecardCriticalDeficiencyKey, string>>;
  // Project cards key scores/notes by the V2 section keys; leadership cards key by the 4 leadership keys.
  // Both are stored in the same maps (disjoint key sets), so the reducer/photo machinery is shared.
  scores: Partial<Record<ScorecardSectionKey | ScorecardLeadershipSectionKey, number>>;
  notes: Partial<Record<ScorecardSectionKey | ScorecardLeadershipSectionKey, string>>;
  photos: ScorecardDraftPhoto[];
  criticalDeficiencies: ScorecardCriticalDeficiencyKey[];
  /** Optional so pre-V2 drafts can resume without a migration. */
  deficiencyNotes?: Partial<Record<ScorecardCriticalDeficiencyKey, string>>;
  actionItems: string[];
  /** Leadership Project Summary free text (voice-dictatable); project cards don't use it. */
  summary?: string;
  /** Once evidence uploading begins, the draft cannot be discarded without reconciling gallery uploads:
   * some photos may already exist while the scorecard POST/PUT remains retryable. Optional for legacy drafts. */
  evidenceUploadAttempted?: boolean;
  /**
   * Durable cleanup ledger for every new-photo client id that has entered a submit attempt. Unlike `photos`,
   * this deliberately retains ids after the user removes a photo from the form, so a submitted-card edit can
   * safely discard its local changes and ask the server to hide any already-confirmed, still-unlinked uploads.
   */
  evidenceUploadAttemptedIds?: string[];
  superintendentSignature?: string;
  pmSignature?: string;
  createdAt: number;
  updatedAt: number;
}

/** A section key valid for either kind — the reducer's score/note maps hold both disjoint key sets. */
export type AnyScorecardSectionKey = ScorecardSectionKey | ScorecardLeadershipSectionKey;

export type DraftAction =
  | { type: "setScore"; sectionKey: AnyScorecardSectionKey; points: number }
  | { type: "setNote"; sectionKey: AnyScorecardSectionKey; note: string }
  | { type: "appendNote"; sectionKey: AnyScorecardSectionKey; text: string }
  | { type: "setHeader"; field: "superintendentName" | "pmName" | "weekOf"; value: string }
  | { type: "setSummary"; value: string }
  | { type: "appendSummary"; text: string }
  | { type: "toggleDeficiency"; key: ScorecardCriticalDeficiencyKey }
  | { type: "setDeficiencyNote"; key: ScorecardCriticalDeficiencyKey; note: string }
  | { type: "appendDeficiencyNote"; key: ScorecardCriticalDeficiencyKey; text: string }
  | { type: "setActionItems"; items: string[] }
  | { type: "addActionItem" }
  | { type: "setActionItem"; index: number; value: string }
  | { type: "removeActionItem"; index: number }
  | { type: "setSignature"; field: "superintendentSignature" | "pmSignature"; value: string }
  | { type: "appendActionItem"; text: string }
  | { type: "markEvidenceUploadAttempted"; clientUploadIds?: string[] }
  | { type: "replaceDraft"; draft: ScorecardDraft }
  | { type: "refreshExistingPhotoUrls"; urlsByScorecardPhotoId: Record<string, string> }
  | { type: "addPhoto"; photo: ScorecardDraftPhoto }
  | { type: "removePhoto"; key: string }
  | { type: "setPhotoCaption"; key: string; caption: string }
  | { type: "appendPhotoCaption"; key: string; text: string };

export interface ScorecardSubmissionPayload {
  clientSubmissionId: string;
  /** Discriminates project (default) vs leadership; both POST to /field/scorecards. Omitted for project. */
  kind?: ScorecardKind;
  dealId: string;
  weekOf: string;
  superintendentName: string | null;
  pmName: string | null;
  items: { sectionKey: AnyScorecardSectionKey; points: number; note: string | null }[];
  criticalDeficiencies: string[];
  actionItems: string[];
  criticalDeficiencyNotes: Record<string, string>;
  photos: {
    sectionKey: ScorecardSectionKey | ScorecardLeadershipSectionKey | "critical_deficiency" | typeof FIELD_SCORECARD_LEADERSHIP_SUMMARY_SECTION_KEY;
    deficiencyKey: ScorecardCriticalDeficiencyKey | null;
    clientUploadId: string;
  }[];
  formVersion: 2;
  superintendentSignature: string | null;
  pmSignature: string | null;
  /** Leadership Project Summary free text; omitted for project cards. */
  summary?: string | null;
}

export type ScorecardUpdatePhotoInput =
  | {
      sectionKey: ScorecardDraftPhoto["sectionKey"];
      deficiencyKey: ScorecardCriticalDeficiencyKey | null;
      scorecardPhotoId: string;
    }
  | {
      sectionKey: ScorecardDraftPhoto["sectionKey"];
      deficiencyKey: ScorecardCriticalDeficiencyKey | null;
      clientUploadId: string;
    };

/** Full replacement body for PUT /field/scorecards/:id. Identity, kind, week, and submitter stay immutable. */
export interface ScorecardUpdatePayload {
  expectedUpdatedAt: string;
  superintendentName: string | null;
  pmName: string | null;
  items: { sectionKey: AnyScorecardSectionKey; points: number; note: string | null }[];
  criticalDeficiencies: string[];
  criticalDeficiencyNotes: Record<string, string>;
  actionItems: string[];
  superintendentSignature: string | null;
  pmSignature: string | null;
  summary: string | null;
  photos: ScorecardUpdatePhotoInput[];
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
    deficiencyNotes: {},
    actionItems: [],
    evidenceUploadAttempted: false,
    superintendentSignature: "",
    pmSignature: "",
    createdAt: input.now,
    updatedAt: input.now,
  };
}

/** The Super/PM names the FIELD team route resolves for a deal (already the newest ACTIVE assignees). */
export interface ScorecardTeamNames {
  superintendentName: string | null;
  pmName: string | null;
}

/**
 * Create a leadership-kind draft. Reuses the project draft shape (so draft-store / photo capture / submit
 * are shared) and sets `kind: "leadership"` plus the leadership-only header fields. The Evaluator is the
 * submitting user — seeded from `evaluatorName` (auto = current user's name) and shown read-only (the
 * server stamps the submitter as the evaluator); Super/PM are pre-filled from the deal team like the
 * project card. Summary + summary photos start empty. No signatures.
 */
export function createLeadershipScorecardDraft(input: {
  id: string;
  clientSubmissionId: string;
  dealId: string;
  dealName: string;
  projectNumber: string | null;
  weekOf: string;
  now: number;
  evaluatorName?: string;
  superintendentName?: string;
  pmName?: string;
}): ScorecardDraft {
  return {
    ...createScorecardDraft(input),
    kind: "leadership",
    evaluatorName: input.evaluatorName ?? "",
    summary: "",
  };
}

/** True iff this draft is a leadership scorecard (absent kind ⇒ legacy project draft). */
export function isLeadershipDraft(draft: ScorecardDraft): boolean {
  return draft.kind === "leadership";
}

export function isEditingScorecardDraft(draft: ScorecardDraft): boolean {
  return Boolean(draft.editingScorecardId && draft.editBaseUpdatedAt);
}

export function isExistingScorecardDraftPhoto(
  photo: ScorecardDraftPhoto,
): photo is ExistingScorecardDraftPhoto {
  return typeof photo.existingScorecardPhotoId === "string" && photo.existingScorecardPhotoId.length > 0;
}

export function isNewScorecardDraftPhoto(photo: ScorecardDraftPhoto): photo is NewScorecardDraftPhoto {
  return !isExistingScorecardDraftPhoto(photo);
}

export function scorecardDraftNewPhotos(draft: ScorecardDraft): NewScorecardDraftPhoto[] {
  return draft.photos.filter(isNewScorecardDraftPhoto);
}

/**
 * Persist the ids that are about to enter the upload queue before the drain starts. The ledger is append-only:
 * removing a photo from the editable form must not erase the only handle the discard cleanup endpoint can use
 * to find an upload that may already have confirmed into the project gallery.
 */
export function markScorecardEvidenceUploadAttempted(
  draft: ScorecardDraft,
  clientUploadIds: readonly string[],
): ScorecardDraft {
  // `undefined` on an already-attempted draft means it predates the cleanup ledger. Never manufacture a
  // partial ledger from only the photos that happen to remain today: an older attempt may already have
  // confirmed a photo that the user later removed, and treating the partial list as complete would orphan it.
  const canMaintainCompleteLedger = draft.evidenceUploadAttemptedIds !== undefined || !draft.evidenceUploadAttempted;
  const attempted = canMaintainCompleteLedger ? [...(draft.evidenceUploadAttemptedIds ?? [])] : [];
  const seen = new Set(attempted);
  for (const rawId of clientUploadIds) {
    const id = rawId.trim();
    if (!id || seen.has(id)) continue;
    attempted.push(id);
    seen.add(id);
  }
  const idsChanged = canMaintainCompleteLedger && attempted.length !== (draft.evidenceUploadAttemptedIds?.length ?? 0);
  if (draft.evidenceUploadAttempted && !idsChanged) return draft;
  return {
    ...draft,
    evidenceUploadAttempted: true,
    ...(canMaintainCompleteLedger && attempted.length > 0 ? { evidenceUploadAttemptedIds: attempted } : {}),
  };
}

/**
 * Every client id that a submitted-edit discard must reconcile. An absent ledger on an already-attempted
 * legacy draft is intentionally NOT reconstructed from its current photos: removed uploads would be unknown,
 * so that draft must remain blocked from discard rather than presenting a partial list as complete.
 */
export function scorecardDraftEvidenceCleanupIds(draft: ScorecardDraft): string[] {
  if (!draft.evidenceUploadAttemptedIds) return [];
  return [...new Set(draft.evidenceUploadAttemptedIds)].filter((id) => id.trim().length > 0);
}

/**
 * Best-effort names to pre-fill the scorecard header from a deal's assigned team. The FIELD team route
 * (GET /field/projects/:dealId/team) already resolves the MOST-RECENT active superintendent / project_manager
 * from ACTIVE user/contact identities — the SAME selection resolveScorecardTeamEmails uses — so the prefilled
 * name is the same person the completed-scorecard email is sent to. This just normalizes the payload for the
 * seed: whitespace-only / null names become absent, so the caller leaves the field as-is (never overwrites a
 * name the user already typed). Pure (no I/O) so it stays unit-testable.
 */
export function resolveScorecardTeamNames(team: Partial<ScorecardTeamNames> | null | undefined): {
  superintendentName?: string;
  pmName?: string;
} {
  const clean = (value: string | null | undefined): string | undefined => {
    const name = (value ?? "").trim();
    return name ? name : undefined;
  };
  const out: { superintendentName?: string; pmName?: string } = {};
  const superintendentName = clean(team?.superintendentName);
  if (superintendentName) out.superintendentName = superintendentName;
  const pmName = clean(team?.pmName);
  if (pmName) out.pmName = pmName;
  return out;
}

/**
 * Fold resolved team names into a draft, filling ONLY the header fields that are still blank — an
 * already-typed name (or a value seeded earlier) is never clobbered. Returns the SAME draft reference when
 * nothing changes, so a no-op seed can't trigger a needless autosave. Pure + editable-preserving: this only
 * seeds initial text; the fields remain fully editable via the normal setHeader action.
 */
export function seedScorecardDraftTeam(
  draft: ScorecardDraft,
  names: { superintendentName?: string; pmName?: string },
): ScorecardDraft {
  const next: Partial<Pick<ScorecardDraft, "superintendentName" | "pmName">> = {};
  if (!draft.superintendentName.trim() && names.superintendentName) next.superintendentName = names.superintendentName;
  if (!draft.pmName.trim() && names.pmName) next.pmName = names.pmName;
  if (Object.keys(next).length === 0) return draft;
  return { ...draft, ...next };
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
    case "setSummary":
      return { ...draft, summary: action.value };
    case "appendSummary": {
      // Append a dictated transcript to the LATEST summary (from reducer state) so a transcript that lands
      // after the user kept typing doesn't clobber those edits — mirrors appendNote.
      const current = draft.summary ?? "";
      const next = current.trim() ? `${current} ${action.text}`.trim() : action.text.trim();
      return { ...draft, summary: next };
    }
    case "toggleDeficiency": {
      const has = draft.criticalDeficiencies.includes(action.key);
      return {
        ...draft,
        criticalDeficiencies: has
          ? draft.criticalDeficiencies.filter((k) => k !== action.key)
          : [...draft.criticalDeficiencies, action.key],
      };
    }
    case "setDeficiencyNote":
      return { ...draft, deficiencyNotes: { ...(draft.deficiencyNotes ?? {}), [action.key]: action.note } };
    case "appendDeficiencyNote": {
      const current = draft.deficiencyNotes?.[action.key] ?? "";
      const next = current.trim() ? `${current} ${action.text}`.trim() : action.text.trim();
      return { ...draft, deficiencyNotes: { ...(draft.deficiencyNotes ?? {}), [action.key]: next } };
    }
    case "setActionItems":
      return { ...draft, actionItems: action.items };
    case "addActionItem":
      return { ...draft, actionItems: [...draft.actionItems, ""] };
    case "setActionItem": {
      if (action.index < 0 || action.index >= draft.actionItems.length) return draft;
      const actionItems = [...draft.actionItems];
      actionItems[action.index] = action.value;
      return { ...draft, actionItems };
    }
    case "removeActionItem":
      return action.index < 0 || action.index >= draft.actionItems.length
        ? draft
        : { ...draft, actionItems: draft.actionItems.filter((_, index) => index !== action.index) };
    case "setSignature":
      return { ...draft, [action.field]: action.value };
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
    case "markEvidenceUploadAttempted":
      return markScorecardEvidenceUploadAttempted(draft, action.clientUploadIds ?? []);
    case "replaceDraft":
      return action.draft;
    case "refreshExistingPhotoUrls": {
      let changed = false;
      const photos = draft.photos.map((photo) => {
        if (!isExistingScorecardDraftPhoto(photo)) return photo;
        const uri = action.urlsByScorecardPhotoId[photo.existingScorecardPhotoId];
        if (uri === undefined || uri === photo.uri) return photo;
        changed = true;
        return { ...photo, uri };
      });
      return changed ? { ...draft, photos } : draft;
    }
    case "addPhoto":
      return { ...draft, photos: [...draft.photos, action.photo] };
    case "removePhoto":
      return { ...draft, photos: draft.photos.filter((p) => p.key !== action.key) };
    case "setPhotoCaption": {
      // A retained scorecard photo's caption is shared project-gallery file metadata, not scorecard-link
      // content. Submitted-card edits keep it read-only; only a newly captured/imported photo can change it
      // before upload persists the caption through the existing photo pipeline.
      const target = draft.photos.find((photo) => photo.key === action.key);
      if (!target || isExistingScorecardDraftPhoto(target)) return draft;
      return {
        ...draft,
        photos: draft.photos.map((p) => (p.key === action.key ? { ...p, caption: action.caption } : p)),
      };
    }
    case "appendPhotoCaption": {
      const target = draft.photos.find((photo) => photo.key === action.key);
      if (!target || isExistingScorecardDraftPhoto(target)) return draft;
      return {
        ...draft,
        photos: draft.photos.map((p) => (
          p.key === action.key
            ? { ...p, caption: p.caption.trim() ? `${p.caption} ${action.text}`.trim() : action.text.trim() }
            : p
        )),
      };
    }
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
  return scorecardDraftAverage(draft);
}

/** The section keys this draft is scored against — the leadership 4 or the project 8. */
function draftSectionKeys(draft: ScorecardDraft): readonly AnyScorecardSectionKey[] {
  return draft.kind === "leadership" ? FIELD_SCORECARD_LEADERSHIP_SECTION_KEYS : FIELD_SCORECARD_SECTION_KEYS;
}

export function scorecardDraftAverage(draft: ScorecardDraft): number {
  const keys = draftSectionKeys(draft);
  const answered = keys.filter((k) => typeof draft.scores[k] === "number");
  if (answered.length === 0) return 0;
  return Math.round((answered.reduce((sum, k) => sum + (draft.scores[k] ?? 0), 0) / keys.length) * 10) / 10;
}

export function scorecardDraftSectionsAnswered(draft: ScorecardDraft): number {
  return draftSectionKeys(draft).filter((k) => typeof draft.scores[k] === "number").length;
}

/** Completion percentage for the editor progress bar, based on actually-rated categories. */
export function scorecardDraftCompletionPercent(draft: ScorecardDraft): number {
  const keys = draftSectionKeys(draft);
  return keys.length === 0 ? 0 : (scorecardDraftSectionsAnswered(draft) / keys.length) * 100;
}

export function isScorecardDraftComplete(draft: ScorecardDraft): boolean {
  return draftSectionKeys(draft).every((k) => typeof draft.scores[k] === "number");
}

export function scorecardDraftRating(draft: ScorecardDraft): ScorecardRating {
  return resolveScorecardRating(scorecardDraftTotal(draft));
}

export function scorecardActionItemsRequired(draft: ScorecardDraft): boolean {
  void draft;
  return false;
}

export function scorecardDraftPhotosForSection(
  draft: ScorecardDraft,
  sectionKey: ScorecardSectionKey | ScorecardLeadershipSectionKey | typeof FIELD_SCORECARD_LEADERSHIP_SUMMARY_SECTION_KEY,
): ScorecardDraftPhoto[] {
  return draft.photos.filter((p) => p.sectionKey === sectionKey);
}

/** Leadership Project Summary photos (sectionKey `project_summary`). */
export function scorecardDraftSummaryPhotos(draft: ScorecardDraft): ScorecardDraftPhoto[] {
  return draft.photos.filter((p) => p.sectionKey === FIELD_SCORECARD_LEADERSHIP_SUMMARY_SECTION_KEY);
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

/**
 * Today's date as a device-LOCAL YYYY-MM-DD (never toISOString/UTC). Used to stamp Week Of = the completion
 * date at SUBMIT time, so a draft started one day and submitted the next files under the submit day, and an
 * evening submit west of UTC files under today (not tomorrow). Matches the seeding format in the entry screen.
 */
export function todayLocalIso(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export interface DraftValidation {
  canSubmit: boolean;
  missingSections: AnyScorecardSectionKey[];
  needsActionItems: boolean;
  missingWeekOf: boolean; // true when Week Of is blank OR not a real calendar date
  missingSignatures: boolean;
  tooManyPhotos: boolean;
  photoOverflowCount: number;
}
export function validateScorecardDraft(draft: ScorecardDraft): DraftValidation {
  const leadership = draft.kind === "leadership";
  const missingSections = draftSectionKeys(draft).filter((k) => typeof draft.scores[k] !== "number");
  const needsActionItems = false;
  // Leadership: no signatures, and Week Of is stamped LOCAL at submit (submitScorecard → todayLocalIso), like
  // the project V2 card — so no client-side week-of/signature gate. Project path is unchanged.
  const missingWeekOf = leadership ? false : !isValidWeekOf(draft.weekOf);
  const missingSignatures = leadership
    ? false
    : !(draft.superintendentSignature ?? "").trim() || !(draft.pmSignature ?? "").trim();
  const photoOverflowCount = Math.max(0, draft.photos.length - MAX_SCORECARD_PHOTOS);
  const tooManyPhotos = photoOverflowCount > 0;
  return {
    missingSections,
    needsActionItems,
    missingWeekOf,
    missingSignatures,
    tooManyPhotos,
    photoOverflowCount,
    canSubmit: missingSections.length === 0
      && !needsActionItems
      && !missingWeekOf
      && !missingSignatures
      && !tooManyPhotos
      && draft.dealId.length > 0,
  };
}

/** Build the POST /field/scorecards payload. Call only when validateScorecardDraft().canSubmit. */
export function scorecardDraftToSubmission(draft: ScorecardDraft): ScorecardSubmissionPayload {
  if (draft.kind === "leadership") return leadershipDraftToSubmission(draft);
  return {
    formVersion: 2,
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
    criticalDeficiencyNotes: Object.fromEntries(
      draft.criticalDeficiencies
        .map((key) => [key, draft.deficiencyNotes?.[key]?.trim() ?? ""])
        .filter(([, note]) => note.length > 0),
    ),
    actionItems: draft.actionItems.map((s) => s.trim()).filter((s) => s.length > 0),
    photos: draft.photos
      .filter(isNewScorecardDraftPhoto)
      .map((p) => ({ sectionKey: p.sectionKey, deficiencyKey: p.deficiencyKey ?? null, clientUploadId: p.clientUploadId })),
    superintendentSignature: draft.superintendentSignature?.trim() || null,
    pmSignature: draft.pmSignature?.trim() || null,
  };
}

/**
 * Leadership payload: `kind: "leadership"`, the 4 leadership items in canonical order (with dictated
 * comment notes), the free-text summary, and category/Project Summary photos. No
 * signatures / deficiencies / action items — leadership cards don't collect them. weekOf is sent but the
 * server stamps the real completion date (like project V2), so a device value can't file under a stale week.
 */
function leadershipDraftToSubmission(draft: ScorecardDraft): ScorecardSubmissionPayload {
  return {
    formVersion: 2,
    kind: "leadership",
    clientSubmissionId: draft.clientSubmissionId,
    dealId: draft.dealId,
    weekOf: draft.weekOf,
    superintendentName: draft.superintendentName.trim() || null,
    pmName: draft.pmName.trim() || null,
    items: FIELD_SCORECARD_LEADERSHIP_SECTION_KEYS.map((k) => ({
      sectionKey: k,
      points: draft.scores[k] ?? 0,
      note: draft.notes[k]?.trim() ? draft.notes[k]!.trim() : null,
    })),
    criticalDeficiencies: [],
    criticalDeficiencyNotes: {},
    actionItems: [],
    photos: draft.photos
      .filter(isNewScorecardDraftPhoto)
      .filter((p) => p.sectionKey === FIELD_SCORECARD_LEADERSHIP_SUMMARY_SECTION_KEY || FIELD_SCORECARD_LEADERSHIP_SECTION_KEYS.includes(p.sectionKey as ScorecardLeadershipSectionKey))
      .map((p) => ({ sectionKey: p.sectionKey, deficiencyKey: null, clientUploadId: p.clientUploadId })),
    superintendentSignature: null,
    pmSignature: null,
    summary: draft.summary?.trim() || null,
  };
}
