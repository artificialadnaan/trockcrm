// WHICH WORK-TYPE CATALOG TROCK SCOPE SHOULD GRADE A GLASSES WALK AGAINST.
//
// TROCK Scope loads one catalog per walkthrough, chosen by the `jobType` on the create call, and grounds
// every spoken line item against it. The CRM has never sent one, so that side has applied its default —
// `interior_finish_out` — to every walk this company has ever filed. The crews walk exteriors: of 36
// production walks, 86% of extracted line items came back with no work type at all, and a walk with no
// work types is a list nobody can total, price, or roll up by CSI section.
//
// Nobody is ever going to type a job type into the glasses app mid-walk, and asking them to would be a
// worse answer than the one the CRM already holds: the deal the walk is filed against is TYPED. So this
// module answers the question from the deal, and the walk's own `job_type` column stays available as an
// override for the day a client does state one.
//
// TWO SEPARATE QUESTIONS LIVE HERE, and keeping them apart is the whole design:
//   1. WHAT KIND OF WORK IS THIS?  — `resolveGlassesWalkthroughJobType`, a pure function of the deal.
//   2. CAN TROCK SCOPE GRADE THAT? — `SCOPE_GROUNDABLE_JOB_TYPES`, a fact about that deployment.
// The first is a durable statement about the CRM's own vocabulary. The second changes when somebody
// seeds a catalog over there, and getting it wrong is not cosmetic — see that constant's own note.
import { resolveProjectTypeCode } from "../../services/projectNumber.js";

/**
 * The work-type catalogs TROCK Scope can be asked for.
 *
 * A LOCAL COPY of `JOB_TYPES` (trock-scope, shared/src/schema/enums.ts), because that repo is not a
 * dependency of this one. Validated at the ingest route so a client-stated value that TROCK Scope would
 * refuse is a 400 to the caller who can still fix it, rather than a 422 discovered three hops later
 * inside a retrying background job — where the walk is already filed, the bytes are already in R2, and
 * the only symptom is a deal panel stuck on "processing" with the reason buried in a dead letter.
 *
 * Adding a value here without TROCK Scope having it is the harmless direction (that end refuses it); the
 * reverse just means a new type cannot be sent yet. `job_type` deliberately carries no CHECK, so this
 * list and TROCK Scope's own validation are the only two gates — see migration 0243.
 */
export const GLASSES_WALKTHROUGH_JOB_TYPES = [
  "interior_finish_out",
  "roofing_envelope",
  "commercial_ti",
  "service_repair",
] as const;

export type GlassesWalkthroughJobType = (typeof GLASSES_WALKTHROUGH_JOB_TYPES)[number];

/** `job_type` is varchar(40); the longest value above is 19 characters. Bounds the unbounded jsonb the
 *  client-stated value arrives in without letting a payload write an essay. */
export const MAX_GLASSES_WALKTHROUGH_JOB_TYPE_CHARS = 40;

export function isGlassesWalkthroughJobType(value: string): value is GlassesWalkthroughJobType {
  return (GLASSES_WALKTHROUGH_JOB_TYPES as readonly string[]).includes(value);
}

/**
 * THE MAPPING. One row per project-type code the CRM actually configures.
 *
 * Keyed on the `project_type_config.code` digit rather than on `deals.project_type`, because the digit is
 * what this platform treats as the answer everywhere else (`resolveProjectTypeCode`,
 * `aliasedIsServiceProjectSql`, `isServiceProjectDeal`) and because the text column is mostly absent:
 * 646 of 1,351 active deals carry no `project_type` TEXT at all and are typed ONLY by the FK. The
 * resolver below still consults the text FIRST — that is the canonical precedence, and this map is
 * deliberately downstream of it rather than a second opinion about it.
 *
 *   1 Exterior Renovation → roofing_envelope    TROCK Scope's exterior catalog IS its envelope catalog;
 *                                               it was compiled from eight exported exterior estimates.
 *   2 Interior Renovation → interior_finish_out
 *   3 Roofing             → roofing_envelope
 *   4 Service             → service_repair      "4 IS the service project-type code" — the digit the deal
 *                                               NUMBER is stamped from (DFW-4-…).
 *   5 Commercial          → commercial_ti
 *   6 Hospitality         → interior_finish_out Guest rooms and common areas: finish-out work under a
 *                                               label that describes the CLIENT, not the scope.
 *   7 Emergency           → service_repair      Emergency work here is repair-shaped; the project-type
 *                                               discovery found code 4 already absorbing "small
 *                                               repairs/emergency/service-like jobs".
 *   8 Development         → interior_finish_out
 *   9 Residential         → interior_finish_out
 *
 * A code with no row — a legacy `project_type_config` entry deactivated by migration 0069 (Restoration,
 * Student Housing, Senior Living …) never had a code at all, and a code added later would not be here —
 * falls to `interior_finish_out` below, which is exactly what TROCK Scope would apply on its own. So an
 * unmapped type is a no-op rather than a refusal, and adding a row later is a pure improvement.
 */
export const GLASSES_WALKTHROUGH_JOB_TYPE_BY_PROJECT_TYPE_CODE: Readonly<
  Record<string, GlassesWalkthroughJobType>
> = {
  "1": "roofing_envelope",
  "2": "interior_finish_out",
  "3": "roofing_envelope",
  "4": "service_repair",
  "5": "commercial_ti",
  "6": "interior_finish_out",
  "7": "service_repair",
  "8": "interior_finish_out",
  "9": "interior_finish_out",
};

/**
 * What a walk gets when the deal says nothing this map recognises — and what TROCK Scope applies on its
 * own when the field is absent. Named so the two facts are visibly the same fact: the no-signal path is
 * behaviourally identical to not having shipped this at all.
 */
export const GLASSES_WALKTHROUGH_DEFAULT_JOB_TYPE: GlassesWalkthroughJobType = "interior_finish_out";

/** The three project-type signals a deal carries, in the order `resolveProjectTypeCode` reads them. */
export interface GlassesWalkthroughDealJobTypeSignals {
  /** `deals.project_type` — the lowercase text value. Absent on roughly half of active deals. */
  projectType: string | null;
  /** `project_type_config.code` reached through `deals.project_type_id`. The tier that actually decides
   *  for most rows, and the one an earlier helper in this repo wrongly dismissed as an edge case. */
  projectTypeCode: string | null;
  /** `deals.workflow_route`. Last, and weakest: it is NOT NULL DEFAULT 'normal' and nothing ever derived
   *  it from the project type, so 'normal' has never meant "not service" — it usually meant nobody said. */
  workflowRoute: string | null;
}

/**
 * The job type a walk on this deal should be graded under. PURE, TOTAL, and never null.
 *
 * Total on purpose. There is no "we do not know" answer to give TROCK Scope that differs from
 * `interior_finish_out`, because that is precisely what it falls back to; a null here would only push the
 * same decision one layer out and make the callers argue about it separately.
 *
 * `resolveProjectTypeCode` does the tier work rather than a second precedence written here. It is the
 * function the deal NUMBER is stamped from, so a walk is now graded under the same reading of the deal
 * that the deal's own identifier encodes — and if that precedence is ever wrong, it is wrong in one place
 * rather than in two that drift. Its no-signal fallback is "9" (Residential), which lands on the default
 * above; the `?? GLASSES_WALKTHROUGH_DEFAULT_JOB_TYPE` is for a code it could return that this map has no
 * row for, not for the absence of a deal.
 */
export function resolveGlassesWalkthroughJobType(
  deal: GlassesWalkthroughDealJobTypeSignals
): GlassesWalkthroughJobType {
  const code = resolveProjectTypeCode({
    projectType: deal.projectType,
    // `resolveProjectTypeCode` calls the configured digit `projectTypes` — a name inherited from the
    // SyncHub field it originally read. It is `project_type_config.code`, one character, not a list.
    projectTypes: deal.projectTypeCode,
    workflowRoute: deal.workflowRoute === "service" ? "service" : "normal",
  });
  return GLASSES_WALKTHROUGH_JOB_TYPE_BY_PROJECT_TYPE_CODE[code] ?? GLASSES_WALKTHROUGH_DEFAULT_JOB_TYPE;
}

/**
 * THE JOB TYPES TROCK SCOPE CAN ACTUALLY GRADE TODAY — a subset of the vocabulary above, and the
 * difference between the two lists is a walk that lands and a walk that is lost.
 *
 * Naming a job type is not the same as being able to ground one. TROCK Scope's create route refuses a
 * walkthrough whose job type has no seeded work-type catalog — `job_type_unavailable`, HTTP 422 (that
 * repo's server/src/ingest/walkthrough-service.ts). It refuses deliberately: grounding an unseeded type
 * fails at the far end of the pipeline, after the clips have been uploaded, transcoded and transcribed,
 * leaving a walkthrough that looks accepted and can never produce a scope.
 *
 * A 422 IS THE WORST OUTCOME THIS FEATURE CAN PRODUCE, and it is worse than the bug it fixes. The
 * forwarder reads any 4xx as "refused before it created anything — safe to retry"
 * (`ScopeWalkthroughNotCreatedError`, worker/src/jobs/glasses-walkthrough-forward.ts), and the answer
 * cannot change without a deploy on the other side — so the job retries into the identical refusal until
 * the queue gives up and dead-letters it. The walk never reaches TROCK Scope at all. Today a
 * service-typed walk at least produces a mis-catalogued scope; ungated, this change would produce none.
 *
 * SO THE PREFERENCE AND THE WIRE VALUE ARE ALLOWED TO DIFFER. `glasses_walkthroughs.job_type` records
 * what the walk IS — the answer above, whatever it is — and the forward job's payload carries it only if
 * it appears here. When a catalog is seeded on that side, adding its name to this list is the entire
 * change, and the walks already on file are already labelled correctly for a re-forward.
 *
 * DRIFT IS SAFE IN THE DIRECTION IT WILL ACTUALLY DRIFT. Forgetting to grow this list costs a walk the
 * benefit of a catalog that now exists — i.e. exactly today's behaviour, TROCK Scope's own default.
 * Shrinking on that side without shrinking here is the only harmful direction, and a retirement over
 * there is a deliberate act with a deploy attached.
 *
 * Read from `COMPILED_WORK_TYPE_CATALOGS` (trock-scope, shared/src/catalog/work-types.ts) at
 * origin/feat/foundation: `interior_finish_out` and `roofing_envelope` are declared with rows;
 * `commercial_ti` and `service_repair` are named in the enum and have no catalog at all.
 */
export const SCOPE_GROUNDABLE_JOB_TYPES: ReadonlySet<GlassesWalkthroughJobType> = new Set<
  GlassesWalkthroughJobType
>(["interior_finish_out", "roofing_envelope"]);

/**
 * The job type to put on the forward, or null to send nothing and let TROCK Scope apply its own default.
 *
 * The one place the two questions at the top of this file meet. Null is not "we do not know" — the
 * resolver always knows — it is "TROCK Scope cannot use this answer yet", and omitting is how that stays
 * a fact about the far end rather than a wrong label on the walk.
 */
export function scopeForwardableJobType(jobType: string | null): GlassesWalkthroughJobType | null {
  if (jobType === null || !isGlassesWalkthroughJobType(jobType)) return null;
  return SCOPE_GROUNDABLE_JOB_TYPES.has(jobType) ? jobType : null;
}
