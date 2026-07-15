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

/** Compact deterministic digest for persisted concurrency snapshots (two independent 32-bit lanes). */
function contentDigest(value: string): string {
  let left = 0x811c9dc5;
  let right = 0x9e3779b9;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    left = Math.imul(left ^ code, 0x01000193);
    right = Math.imul(right ^ code, 0x85ebca6b);
  }
  const hex = (value32: number) => (value32 >>> 0).toString(16).padStart(8, "0");
  return `v1:${value.length}:${hex(left)}${hex(right)}`;
}

/**
 * Snapshot only scorecard-owned editable content. Gallery captions and presigned URLs are deliberately
 * excluded: their independent mutation bumps updatedAt, but a canonical caption refresh may safely adopt
 * that newer token only when every scorecard-owned field still matches the draft's original base snapshot.
 */
function editableDetailFingerprint(detail: FieldScorecardDetail): string {
  const sortedRecord = (record: Record<string, string>) =>
    Object.fromEntries(Object.entries(record).sort(([left], [right]) => left.localeCompare(right)));
  const items = detail.items
    .map((item) => ({ sectionKey: item.sectionKey, points: item.points, note: item.note ?? null }))
    .sort((left, right) => left.sectionKey.localeCompare(right.sectionKey));
  const photos = detail.photos
    .map((photo) => ({
      id: photo.id,
      fileId: photo.fileId,
      sectionKey: photo.sectionKey,
      deficiencyKey: photo.deficiencyKey ?? null,
    }))
    .sort((left, right) => left.id.localeCompare(right.id));
  return contentDigest(JSON.stringify({
    superintendentName: detail.superintendentName ?? null,
    pmName: detail.pmName ?? null,
    items,
    criticalDeficiencies: [...detail.criticalDeficiencies].sort(),
    criticalDeficiencyNotes: sortedRecord(detail.criticalDeficiencyNotes ?? {}),
    actionItems: detail.actionItems,
    photos,
    superintendentSignature: detail.superintendentSignature ?? null,
    pmSignature: detail.pmSignature ?? null,
    summary: detail.summary ?? null,
  }));
}

function isNewerRevision(candidate: string | undefined, current: string | undefined): candidate is string {
  if (!candidate) return false;
  if (!current) return true;
  const candidateTime = Date.parse(candidate);
  const currentTime = Date.parse(current);
  return Number.isFinite(candidateTime) && Number.isFinite(currentTime) && candidateTime > currentTime;
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

/** Valid project deficiency keys in canonical form order; leadership cards never carry this state. */
function editableCriticalDeficiencies(detail: FieldScorecardDetail): ScorecardCriticalDeficiencyKey[] {
  if (detail.kind === "leadership") return [];
  const selected = new Set(detail.criticalDeficiencies.filter(isCriticalDeficiencyKey));
  return FIELD_SCORECARD_CRITICAL_DEFICIENCIES.map((deficiency) => deficiency.key)
    .filter((key) => selected.has(key));
}

/** Trim and retain only notes belonging to selected, valid deficiencies. */
function editableCriticalDeficiencyNotes(
  detail: FieldScorecardDetail,
  criticalDeficiencies = editableCriticalDeficiencies(detail),
): Partial<Record<ScorecardCriticalDeficiencyKey, string>> {
  return Object.fromEntries(
    criticalDeficiencies
      .map((key) => [key, detail.criticalDeficiencyNotes?.[key]?.trim() ?? ""] as const)
      .filter(([, note]) => note.length > 0),
  );
}

function deficiencyStateChanged(
  currentKeys: readonly ScorecardCriticalDeficiencyKey[],
  currentNotes: ScorecardDraft["deficiencyNotes"],
  nextKeys: readonly ScorecardCriticalDeficiencyKey[],
  nextNotes: ScorecardDraft["deficiencyNotes"],
): boolean {
  const state = (
    keys: readonly ScorecardCriticalDeficiencyKey[],
    notes: ScorecardDraft["deficiencyNotes"],
  ) => JSON.stringify([...keys].sort().map((key) => [key, notes?.[key]?.trim() ?? ""]));
  return state(currentKeys, currentNotes) !== state(nextKeys, nextNotes);
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
  const criticalDeficiencies = editableCriticalDeficiencies(detail);
  const deficiencyNotes = editableCriticalDeficiencyNotes(detail, criticalDeficiencies);
  const photos = retainedPhotos(detail);

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
    editBaseContentFingerprint: editableDetailFingerprint(detail),
    editBasePhotoIds: photos.flatMap((photo) =>
      isExistingScorecardDraftPhoto(photo) ? [photo.existingScorecardPhotoId] : [],
    ),
    ...(detail.kind === "leadership"
      ? {}
      : {
          editBaseCriticalDeficiencies: [...criticalDeficiencies],
          editBaseCriticalDeficiencyNotes: { ...deficiencyNotes },
        }),
    scores,
    notes,
    photos,
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

/** Refresh canonical retained-photo display data; never overwrite locally editable scorecard fields/placement. */
export function refreshScorecardEditPhotoUrls(
  draft: ScorecardDraft,
  detail: FieldScorecardDetail,
): ScorecardDraft {
  if (draft.editingScorecardId !== detail.id) return draft;
  const byId = new Map(detail.photos.map((photo) => [photo.id, photo]));
  let changed = false;
  let captionChanged = false;
  const photos = draft.photos.map((photo) => {
    if (!isExistingScorecardDraftPhoto(photo)) return photo;
    const current = byId.get(photo.existingScorecardPhotoId);
    if (!current) return photo;
    const uri = current.url ?? "";
    const caption = current.caption ?? "";
    if (uri === photo.uri && caption === photo.caption) return photo;
    changed = true;
    if (caption !== photo.caption) captionChanged = true;
    return { ...photo, uri, caption };
  });
  const latestFingerprint = editableDetailFingerprint(detail);
  const canAdvanceRevision = Boolean(
    draft.editBaseContentFingerprint &&
    draft.editBaseContentFingerprint === latestFingerprint,
  );
  const revisionChanged = canAdvanceRevision && isNewerRevision(detail.updatedAt, draft.editBaseUpdatedAt);
  if (!changed && !revisionChanged) return draft;
  const latestCriticalDeficiencies = editableCriticalDeficiencies(detail);
  return {
    ...draft,
    photos,
    editBaseUpdatedAt: revisionChanged ? detail.updatedAt : draft.editBaseUpdatedAt,
    editBaseContentFingerprint: revisionChanged ? latestFingerprint : draft.editBaseContentFingerprint,
    ...(revisionChanged && draft.kind !== "leadership"
      ? {
          editBaseCriticalDeficiencies: latestCriticalDeficiencies,
          editBaseCriticalDeficiencyNotes: editableCriticalDeficiencyNotes(detail, latestCriticalDeficiencies),
        }
      : {}),
    // A retained caption is part of the rendered report even though it is read-only in this editor.
    // Loading a different canonical caption therefore requires fresh project approval; URL rotation alone does not.
    superintendentSignature: draft.kind !== "leadership" && captionChanged ? "" : draft.superintendentSignature,
    pmSignature: draft.kind !== "leadership" && captionChanged ? "" : draft.pmSignature,
  };
}

/**
 * Advance a conflicted local edit onto the latest server revision without replacing the user's editable
 * fields. New local evidence is always retained. Existing evidence links are retained only while that exact
 * link still exists on the latest scorecard; another session may have removed a link, and sending its stale id
 * again would make every retry conflict. Evidence added by the other session is merged in, while a link
 * present in the base snapshot but omitted locally remains omitted (an intentional local removal).
 *
 * Critical-deficiency selection/note state uses a three-way merge because evidence placement depends on it.
 * Other server field values are not merged: choosing "Retry with my changes" is an explicit full-replacement
 * decision, and the user gets another review/save step after this rebase rather than an automatic PUT.
 */
export function rebaseScorecardEditDraft(
  draft: ScorecardDraft,
  detail: FieldScorecardDetail,
): {
  draft: ScorecardDraft;
  removedRetainedPhotoCount: number;
  mergedServerPhotoCount: number;
  updatedRetainedCaptionCount: number;
  mergedServerDeficiencyCount: number;
  removedServerDeficiencyCount: number;
  updatedServerDeficiencyNoteCount: number;
} {
  if (!draft.editingScorecardId || draft.editingScorecardId !== detail.id) {
    throw new Error("The latest scorecard does not match this local edit.");
  }
  if (!detail.canEdit) throw new Error("Only the submitter can edit this scorecard.");
  if (detail.formVersion !== 2) throw new Error("Historical scorecards cannot be edited in T-Rock Cam.");
  const draftLeadership = draft.kind === "leadership";
  const detailLeadership = detail.kind === "leadership";
  if (draft.dealId !== detail.dealId || draftLeadership !== detailLeadership) {
    throw new Error("The latest scorecard does not match this local edit.");
  }

  const latestCriticalDeficiencies = editableCriticalDeficiencies(detail);
  const latestDeficiencySet = new Set(latestCriticalDeficiencies);
  const latestDeficiencyNotes = editableCriticalDeficiencyNotes(detail, latestCriticalDeficiencies);
  const localDeficiencySet = new Set(draft.criticalDeficiencies);
  const localNewDeficiencyEvidence = new Set(
    draft.photos.flatMap((photo) =>
      !isExistingScorecardDraftPhoto(photo) &&
      photo.sectionKey === "critical_deficiency" &&
      photo.deficiencyKey
        ? [photo.deficiencyKey]
        : [],
    ),
  );
  const hasDeficiencyBaseSnapshot = draft.editBaseCriticalDeficiencies !== undefined &&
    draft.editBaseCriticalDeficiencyNotes !== undefined;
  const baseDeficiencySet = new Set(draft.editBaseCriticalDeficiencies ?? []);
  const baseDeficiencyNotes = draft.editBaseCriticalDeficiencyNotes ?? {};
  const criticalDeficiencies: ScorecardCriticalDeficiencyKey[] = [];
  const deficiencyNotes = { ...(draft.deficiencyNotes ?? {}) };
  let mergedServerDeficiencyCount = 0;
  let removedServerDeficiencyCount = 0;
  let updatedServerDeficiencyNoteCount = 0;

  if (!draftLeadership) {
    for (const { key } of FIELD_SCORECARD_CRITICAL_DEFICIENCIES) {
      const baseHas = baseDeficiencySet.has(key);
      const localHasNewEvidence = localNewDeficiencyEvidence.has(key);
      const localHas = localDeficiencySet.has(key) || localHasNewEvidence;
      const latestHas = latestDeficiencySet.has(key);
      const baseNote = baseHas ? baseDeficiencyNotes[key]?.trim() ?? "" : "";
      const localNote = localHas ? draft.deficiencyNotes?.[key]?.trim() ?? "" : "";
      const latestNote = latestHas ? latestDeficiencyNotes[key] ?? "" : "";
      // A new local evidence photo is an explicit dependency on the deficiency even if a legacy/corrupt
      // draft omitted the selection. Selection and note form one three-way state: either local edit wins;
      // when both stayed at the base, adopt a remote selection or note change. Pre-snapshot drafts stay
      // local-biased because their original state is unknowable.
      const localChanged = localHas !== baseHas || localNote !== baseNote || localHasNewEvidence;
      const remoteChanged = latestHas !== baseHas || latestNote !== baseNote;
      let nextHas = localHas;
      const adoptRemote = hasDeficiencyBaseSnapshot && !localChanged && remoteChanged;
      if (adoptRemote) {
        nextHas = latestHas;
        if (latestHas !== baseHas) {
          if (latestHas) mergedServerDeficiencyCount += 1;
          else removedServerDeficiencyCount += 1;
        } else if (latestNote !== baseNote) {
          updatedServerDeficiencyNoteCount += 1;
        }
      }

      if (!nextHas) {
        delete deficiencyNotes[key];
        continue;
      }
      criticalDeficiencies.push(key);
      if (adoptRemote) {
        if (latestNote) deficiencyNotes[key] = latestNote;
        else delete deficiencyNotes[key];
      }
    }
  }
  const finalDeficiencySet = new Set(criticalDeficiencies);
  const photoPlacementAllowed = (photo: ScorecardDraftPhoto) =>
    photo.sectionKey !== "critical_deficiency" ||
    Boolean(photo.deficiencyKey && finalDeficiencySet.has(photo.deficiencyKey));

  const latestDraftPhotos = retainedPhotos(detail);
  const latestPhotos = new Map(
    latestDraftPhotos.flatMap((photo) =>
      isExistingScorecardDraftPhoto(photo) ? [[photo.existingScorecardPhotoId, photo] as const] : [],
    ),
  );
  const localRetainedIds = new Set(
    draft.photos.flatMap((photo) =>
      isExistingScorecardDraftPhoto(photo) ? [photo.existingScorecardPhotoId] : [],
    ),
  );
  // Legacy local edits created before this snapshot field existed use their currently-retained links as the
  // base. This errs toward preserving unknown latest links rather than deleting server evidence silently.
  const basePhotoIds = new Set(draft.editBasePhotoIds ?? [...localRetainedIds]);
  let removedRetainedPhotoCount = 0;
  let updatedRetainedCaptionCount = 0;
  const photos: ScorecardDraftPhoto[] = draft.photos.flatMap((photo): ScorecardDraftPhoto[] => {
    if (!isExistingScorecardDraftPhoto(photo)) return [photo];
    const latest = latestPhotos.get(photo.existingScorecardPhotoId);
    if (!latest || !photoPlacementAllowed(photo)) {
      removedRetainedPhotoCount += 1;
      return [];
    }
    if (photo.caption !== latest.caption) updatedRetainedCaptionCount += 1;
    return [{ ...photo, uri: latest.uri, caption: latest.caption }];
  });
  let mergedServerPhotoCount = 0;
  for (const latest of latestDraftPhotos) {
    if (!isExistingScorecardDraftPhoto(latest)) continue;
    const id = latest.existingScorecardPhotoId;
    // Already retained locally, or present in the base and intentionally removed locally.
    if (localRetainedIds.has(id) || basePhotoIds.has(id)) continue;
    // A locally removed deficiency wins its three-way merge. Do not silently resurrect it merely because the
    // remote edit also added evidence; that evidence will be omitted with the intentionally removed flag.
    if (!photoPlacementAllowed(latest)) continue;
    photos.push(latest);
    mergedServerPhotoCount += 1;
  }

  const evidenceChanged = removedRetainedPhotoCount > 0 ||
    mergedServerPhotoCount > 0 ||
    updatedRetainedCaptionCount > 0;
  const criticalDeficienciesChanged = !draftLeadership && deficiencyStateChanged(
    draft.criticalDeficiencies,
    draft.deficiencyNotes,
    criticalDeficiencies,
    deficiencyNotes,
  );

  return {
    draft: {
      ...draft,
      editingOfficeId: detail.officeId ?? draft.editingOfficeId ?? null,
      editBaseUpdatedAt: detail.updatedAt,
      editBaseContentFingerprint: editableDetailFingerprint(detail),
      editBasePhotoIds: latestDraftPhotos.flatMap((photo) =>
        isExistingScorecardDraftPhoto(photo) ? [photo.existingScorecardPhotoId] : [],
      ),
      ...(!draftLeadership
        ? {
            editBaseCriticalDeficiencies: [...latestCriticalDeficiencies],
            editBaseCriticalDeficiencyNotes: { ...latestDeficiencyNotes },
          }
        : {}),
      photos,
      criticalDeficiencies,
      deficiencyNotes,
      // Project signatures approve the exact report content. If rebase changes submitted evidence OR adopts
      // a remote deficiency change, require both people to review/sign again. A local removal that simply wins
      // the merge leaves the report they already signed unchanged, so its fresh signatures remain valid.
      superintendentSignature: !draftLeadership && (evidenceChanged || criticalDeficienciesChanged) ? "" : draft.superintendentSignature,
      pmSignature: !draftLeadership && (evidenceChanged || criticalDeficienciesChanged) ? "" : draft.pmSignature,
    },
    removedRetainedPhotoCount,
    mergedServerPhotoCount,
    updatedRetainedCaptionCount,
    mergedServerDeficiencyCount,
    removedServerDeficiencyCount,
    updatedServerDeficiencyNoteCount,
  };
}

export function scorecardEditRebaseMessage(result: {
  removedRetainedPhotoCount: number;
  mergedServerPhotoCount: number;
  updatedRetainedCaptionCount: number;
  mergedServerDeficiencyCount?: number;
  removedServerDeficiencyCount?: number;
  updatedServerDeficiencyNoteCount?: number;
}): string {
  const parts = ["Latest revision loaded. Your local changes and new photos were kept."];
  if (result.mergedServerPhotoCount > 0) {
    parts.push(
      `${result.mergedServerPhotoCount} photo${result.mergedServerPhotoCount === 1 ? "" : "s"} added in the other edit ${result.mergedServerPhotoCount === 1 ? "was" : "were"} also preserved.`,
    );
  }
  if (result.removedRetainedPhotoCount > 0) {
    parts.push(
      `${result.removedRetainedPhotoCount} submitted photo${result.removedRetainedPhotoCount === 1 ? "" : "s"} removed in the other edit can’t be reattached automatically.`,
    );
  }
  if (result.updatedRetainedCaptionCount > 0) {
    parts.push(
      `${result.updatedRetainedCaptionCount} submitted photo description${result.updatedRetainedCaptionCount === 1 ? "" : "s"} ${result.updatedRetainedCaptionCount === 1 ? "was" : "were"} refreshed from the latest report.`,
    );
  }
  if ((result.mergedServerDeficiencyCount ?? 0) > 0) {
    const count = result.mergedServerDeficiencyCount ?? 0;
    parts.push(
      `${count} critical deficienc${count === 1 ? "y" : "ies"} added in the other edit ${count === 1 ? "was" : "were"} also preserved.`,
    );
  }
  if ((result.removedServerDeficiencyCount ?? 0) > 0) {
    const count = result.removedServerDeficiencyCount ?? 0;
    parts.push(
      `${count} critical deficienc${count === 1 ? "y" : "ies"} removed in the other edit ${count === 1 ? "was" : "were"} removed from this revision.`,
    );
  }
  if ((result.updatedServerDeficiencyNoteCount ?? 0) > 0) {
    const count = result.updatedServerDeficiencyNoteCount ?? 0;
    parts.push(
      `${count} critical deficiency note${count === 1 ? "" : "s"} updated in the other edit ${count === 1 ? "was" : "were"} loaded for review.`,
    );
  }
  parts.push("Review, then tap Save changes again.");
  return parts.join(" ");
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
