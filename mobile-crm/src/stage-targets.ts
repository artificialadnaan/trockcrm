/**
 * Which stages a given deal may actually be moved INTO.
 *
 * `GET /deals/stages` returns every deal-family stage in the tenant, unfiltered: both workflow
 * families, and retired stages alongside live ones. It is a catalogue, not a menu. Offering it raw
 * walks a rep into a guaranteed rejection — the gate throws INVALID_STAGE_FOR_WORKFLOW_ROUTE for a
 * standard deal pointed at a service stage, and the write guard throws INACTIVE_DEAL_STAGE for a
 * retired one. Both land as an opaque 400 after the rep has already filled in a reason and notes.
 *
 * Mirrors two server rules, kept together because they are two halves of one question:
 *   • isStageValidForWorkflowRoute — server/src/modules/deals/stage-gate.ts:219-235
 *   • assertActiveDealStageWriteTarget — server/src/modules/deals/stage-write-guard.ts:8-11
 *
 * The route rule is ASYMMETRIC, and that asymmetry is the whole reason this is a named, tested helper
 * rather than `stage.workflowFamily === deal.workflowFamily`. A service deal may move into a handful of
 * standard-family stages (the shared canonical spine below); a standard deal may never move into a
 * service one. Writing the obvious symmetric check would silently hide six legitimate targets from every
 * service deal — a wrong-but-plausible filter that no error message would ever reveal.
 */

/** Deal-side workflow families. `lead` also exists in the enum and is never a deal target. */
export type StageWorkflowFamily = "standard_deal" | "service_deal" | "lead" | (string & {});

export type StageTarget = {
  id: string;
  slug: string;
  workflowFamily?: StageWorkflowFamily | null;
  isActivePipeline?: boolean;
};

/**
 * Standard-family stages a SERVICE deal may still use — the shared canonical spine.
 *
 * Mirrors SHARED_CANONICAL_DEAL_STAGE_SLUGS (stage-gate.ts:208-217). `opportunity` is in here for a
 * non-obvious reason worth preserving: it is the CRM-side RFP approval trigger that runs before Bid
 * Board-owned progression, so service deals genuinely pass through it.
 */
const SHARED_CANONICAL_DEAL_STAGE_SLUGS = new Set([
  "opportunity",
  "estimate_under_review",
  "estimate_sent_to_client",
  "contract",
  "won",
  "lost",
]);

function requiredFamilyForRoute(workflowRoute: string | null | undefined) {
  return workflowRoute === "service" ? "service_deal" : "standard_deal";
}

/**
 * Does the stage-gate accept this stage for this deal's route?
 *
 * A null/absent family is permitted, matching the server: it treats an unset family as "unconstrained"
 * rather than as a mismatch, so this must not tighten it.
 */
export function isStageValidForWorkflowRoute(
  stage: Pick<StageTarget, "slug" | "workflowFamily">,
  workflowRoute: string | null | undefined,
): boolean {
  const family = stage.workflowFamily ?? null;
  if (family === "lead") return false;

  if (!family || family === requiredFamilyForRoute(workflowRoute)) return true;

  return (
    workflowRoute === "service" &&
    family === "standard_deal" &&
    SHARED_CANONICAL_DEAL_STAGE_SLUGS.has(stage.slug)
  );
}

/**
 * The stages to actually offer: route-valid, still live, and not the stage the deal is already in.
 *
 * `isActivePipeline` defaults to TRUE when absent. The column is NOT NULL with a true default server-
 * side, so a missing value means an older payload shape, not a retired stage — defaulting to false
 * there would empty the menu completely and make the feature look broken.
 */
export function eligibleStageTargets<T extends StageTarget>(
  stages: readonly T[],
  deal: { stageId?: string | null; workflowRoute?: string | null },
): T[] {
  return stages.filter(
    (stage) =>
      stage.id !== deal.stageId &&
      (stage.isActivePipeline ?? true) &&
      isStageValidForWorkflowRoute(stage, deal.workflowRoute),
  );
}
