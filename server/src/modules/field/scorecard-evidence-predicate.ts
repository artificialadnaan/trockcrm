import { and, isNull } from "drizzle-orm";
import { fieldScorecardPhotos } from "@trock-crm/shared/schema";

/**
 * "This photo is ORIGINAL evidence, not a corrective-action response."
 *
 * SIX readers ask this question — the evidence fingerprint, its publication recheck, the PDF evidence pages,
 * the CRM evidence grid and two list reads — and #973 established that they must agree exactly: when only
 * the recheck saw response photos, its fingerprint differed from the initial read and every regeneration
 * raised a spurious SCORECARD_EVIDENCE_CHANGED.
 *
 * `corrective_action_id IS NULL` alone stopped being sufficient the moment that FK became ON DELETE SET NULL
 * (migration 0202, so an edit removing a flagged item cannot erase its evidence). A DETACHED response photo
 * has a null item id and is emphatically not original evidence — without the second clause it would surface
 * in the evidence pages, the CRM grid and the fingerprint. `corrective_action_event_id` survives the
 * detachment, so the pair is what actually distinguishes the two kinds.
 */
export function isOriginalEvidencePhoto() {
  return and(
    isNull(fieldScorecardPhotos.correctiveActionId),
    isNull(fieldScorecardPhotos.correctiveActionEventId),
  );
}
