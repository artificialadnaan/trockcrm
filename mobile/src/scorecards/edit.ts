import type { FieldScorecardDetail } from "../api/types";
import {
  FIELD_SCORECARD_CRITICAL_DEFICIENCIES,
  FIELD_SCORECARD_LEADERSHIP_SECTION_KEYS,
  FIELD_SCORECARD_LEADERSHIP_SUMMARY_SECTION_KEY,
  FIELD_SCORECARD_SECTION_KEYS,
  type ScorecardCriticalDeficiencyKey,
} from "./scoring";
import {
  isExistingScorecardDraftPhoto,
  type AnyScorecardSectionKey,
  type ScorecardDraft,
  type ScorecardDraftPhoto,
  type ScorecardUpdatePayload,
} from "./draft";

const CRITICAL_DEFICIENCY_KEYS = new Set<string>(
  FIELD_SCORECARD_CRITICAL_DEFICIENCIES.map((deficiency) => deficiency.key),
);
const PROJECT_SECTION_KEYS = new Set<string>(FIELD_SCORECARD_SECTION_KEYS);
const LEADERSHIP_SECTION_KEYS = new Set<string>(FIELD_SCORECARD_LEADERSHIP_SECTION_KEYS);

function isCriticalDeficiencyKey(value: string): value is ScorecardCriticalDeficiencyKey {
  return CRITICAL_DEFICIENCY_KEYS.has(value);
}

function projectName(detail: FieldScorecardDetail): string {
  const canonical = detail.projectName?.trim();
  if (canonical) return canonical;
  return detail.projectNumber ? `Project ${detail.projectNumber}` : "Untitled project";
}

function editableItems(detail: FieldScorecardDetail): {
  scores: ScorecardDraft["scores"];
  notes: ScorecardDraft["notes"];
} {
  const scores: ScorecardDraft["scores"] = {};
  const notes: ScorecardDraft["notes"] = {};
  const validKeys = detail.kind === "leadership" ? LEADERSHIP_SECTION_KEYS : PROJECT_SECTION_KEYS;
  for (const item of detail.items) {
    if (!validKeys.has(item.sectionKey)) continue;
    const key = item.sectionKey as AnyScorecardSectionKey;
    scores[key] = item.points;
    if (item.note) notes[key] = item.note;
  }
  return { scores, notes };
}

function retainedPhotos(detail: FieldScorecardDetail): ScorecardDraftPhoto[] {
  return detail.photos.flatMap((photo) => {
    const sectionAllowed = detail.kind === "leadership"
      ? LEADERSHIP_SECTION_KEYS.has(photo.sectionKey) || photo.sectionKey === FIELD_SCORECARD_LEADERSHIP_SUMMARY_SECTION_KEY
      : PROJECT_SECTION_KEYS.has(photo.sectionKey) || photo.sectionKey === "critical_deficiency";
    if (!sectionAllowed) return [];
    const deficiencyKey = photo.deficiencyKey && isCriticalDeficiencyKey(photo.deficiencyKey)
      ? photo.deficiencyKey
      : undefined;
    return [{
      key: `submitted:${photo.id}`,
      uri: photo.url ?? "",
      existingScorecardPhotoId: photo.id,
      sectionKey: photo.sectionKey,
      deficiencyKey,
      caption: photo.caption ?? "",
    } satisfies ScorecardDraftPhoto];
  });
}

/**
 * Hydrate a submitted V2 scorecard into the existing persisted draft editor. A fresh random local id is
 * supplied by the caller so deleting one edit never collides with draft-store's process-lifetime tombstone.
 * Project signatures intentionally start blank: an edited project card must be freshly re-approved by both
 * signers before Save changes is enabled. Leadership scorecards do not collect signatures.
 */
export function createScorecardEditDraft(
  detail: FieldScorecardDetail,
  input: { id: string; clientSubmissionId: string; now: number },
): ScorecardDraft {
  if (!detail.canEdit) throw new Error("Only the submitter can edit this scorecard.");
  if (detail.formVersion !== 2) throw new Error("Historical scorecards cannot be edited in T-Rock Cam.");

  const { scores, notes } = editableItems(detail);
  const criticalDeficiencies = detail.kind === "leadership"
    ? []
    : detail.criticalDeficiencies.filter(isCriticalDeficiencyKey);
  const deficiencyNotes = Object.fromEntries(
    criticalDeficiencies
      .map((key) => [key, detail.criticalDeficiencyNotes?.[key]?.trim() ?? ""])
      .filter(([, note]) => note.length > 0),
  ) as Partial<Record<ScorecardCriticalDeficiencyKey, string>>;

  return {
    id: input.id,
    clientSubmissionId: input.clientSubmissionId,
    kind: detail.kind === "leadership" ? "leadership" : undefined,
    dealId: detail.dealId,
    dealName: projectName(detail),
    projectNumber: detail.projectNumber,
    weekOf: detail.weekOf,
    superintendentName: detail.superintendentName ?? "",
    pmName: detail.pmName ?? "",
    evaluatorName: detail.kind === "leadership" ? detail.submittedByName ?? "" : undefined,
    editingScorecardId: detail.id,
    editingOfficeId: detail.officeId ?? null,
    editBaseUpdatedAt: detail.updatedAt,
    scores,
    notes,
    photos: retainedPhotos(detail),
    criticalDeficiencies,
    deficiencyNotes,
    actionItems: detail.kind === "leadership" ? [] : [...detail.actionItems],
    summary: detail.kind === "leadership" ? detail.summary ?? "" : undefined,
    evidenceUploadAttempted: false,
    // An edited project card requires fresh approval rather than silently reusing old signatures.
    superintendentSignature: "",
    pmSignature: "",
    createdAt: input.now,
    updatedAt: input.now,
  };
}

/** Refresh only retained-photo display data; never overwrite the user's locally edited scorecard fields. */
export function refreshScorecardEditPhotoUrls(
  draft: ScorecardDraft,
  detail: FieldScorecardDetail,
): ScorecardDraft {
  if (draft.editingScorecardId !== detail.id) return draft;
  const byId = new Map(detail.photos.map((photo) => [photo.id, photo]));
  let changed = false;
  const photos = draft.photos.map((photo) => {
    if (!isExistingScorecardDraftPhoto(photo)) return photo;
    const current = byId.get(photo.existingScorecardPhotoId);
    if (!current) return photo;
    const uri = current.url ?? "";
    if (uri === photo.uri) return photo;
    changed = true;
    return { ...photo, uri };
  });
  return changed ? { ...draft, photos } : draft;
}

function canonicalItems(draft: ScorecardDraft): ScorecardUpdatePayload["items"] {
  const keys: readonly AnyScorecardSectionKey[] = draft.kind === "leadership"
    ? FIELD_SCORECARD_LEADERSHIP_SECTION_KEYS
    : FIELD_SCORECARD_SECTION_KEYS;
  return keys.map((sectionKey) => ({
    sectionKey,
    points: draft.scores[sectionKey] ?? 0,
    note: draft.notes[sectionKey]?.trim() || null,
  }));
}

/** Build the same-card full replacement body. Week, identity, kind, and submitter are intentionally absent. */
export function scorecardDraftToUpdate(draft: ScorecardDraft): ScorecardUpdatePayload {
  if (!draft.editingScorecardId || !draft.editBaseUpdatedAt) {
    throw new Error("A submitted scorecard edit is missing its server revision.");
  }
  const leadership = draft.kind === "leadership";
  const criticalDeficiencies = leadership ? [] : [...draft.criticalDeficiencies];
  return {
    expectedUpdatedAt: draft.editBaseUpdatedAt,
    superintendentName: draft.superintendentName.trim() || null,
    pmName: draft.pmName.trim() || null,
    items: canonicalItems(draft),
    criticalDeficiencies,
    criticalDeficiencyNotes: leadership
      ? {}
      : Object.fromEntries(
          criticalDeficiencies
            .map((key) => [key, draft.deficiencyNotes?.[key]?.trim() ?? ""])
            .filter(([, note]) => note.length > 0),
        ),
    actionItems: leadership ? [] : draft.actionItems.map((item) => item.trim()).filter(Boolean),
    superintendentSignature: leadership ? null : draft.superintendentSignature?.trim() || null,
    pmSignature: leadership ? null : draft.pmSignature?.trim() || null,
    summary: leadership ? draft.summary?.trim() || null : null,
    photos: draft.photos.map((photo) => {
      const common = { sectionKey: photo.sectionKey, deficiencyKey: photo.deficiencyKey ?? null };
      return isExistingScorecardDraftPhoto(photo)
        ? { ...common, scorecardPhotoId: photo.existingScorecardPhotoId }
        : { ...common, clientUploadId: photo.clientUploadId };
    }),
  };
}
