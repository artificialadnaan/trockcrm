import type { DealListItem } from "./api/types";
import { formatMoney } from "./format";

/**
 * The money and at-risk rules a deal card shows.
 *
 * Split out of DealCard.tsx when the two card components were merged into one. They had always been
 * logic rather than presentation — `deals/[id].tsx` and the endpoint tests both imported them from a
 * component file, and BoardCard imported them from its own sibling, so deleting either component would
 * have taken the pipeline's value rule with it.
 */

/**
 * The fields the value display reads. `effectiveValue` is the SERVER's number; the raw money columns are
 * kept only as a fallback for a payload that predates it.
 */
type ValueFields = Pick<
  DealListItem,
  | "effectiveValue"
  | "effectiveOnHold"
  | "onHold"
  | "awardedAmount"
  | "bidEstimate"
  | "ddEstimate"
  | "bidBoardTotalSales"
  | "stageSlug"
  | "workflowRoute"
>;

/**
 * Slugs that canonicalize to the genuine normal-route `estimating` stage.
 *
 * Mirrors LEGACY_DEAL_STAGE_TO_CANONICAL_STAGE.normal in shared/src/types/workflow.ts:241-245. This is a
 * MIRROR rather than an import because mobile-crm is a standalone Expo app — deliberately not an npm
 * workspace, so Metro resolves from its own node_modules and cannot reach shared/. Kept to just the
 * aliases that land on `estimating`, so the drift surface is one line rather than a whole table.
 */
const ESTIMATING_STAGE_SLUGS = new Set(["estimating", "estimate_in_progress"]);

/**
 * Is this the genuine normal-route estimating stage — the one where DD outranks the in-progress bid?
 *
 * Route-aware, matching isGenuineEstimatingDealStageSlug. Both slugs map to `service_estimating` on the
 * service route, which is deliberately NOT estimating, so the service route short-circuits to false.
 */
export function isGenuineEstimatingStage(
  stageSlug: string | null | undefined,
  workflowRoute: string | null | undefined,
): boolean {
  if (workflowRoute === "service") return false;
  return Boolean(stageSlug && ESTIMATING_STAGE_SLUGS.has(stageSlug));
}

/**
 * The deal value to display.
 *
 * PREFERS the server's `effectiveValue`, which already applies the canonical hold rule — a deal that is
 * effectively on hold is worth 0, and "effectively" ORs the stored flag with a close target more than 90
 * America/Chicago days out, exempting terminal deals. Recomputing that on device would be a second
 * implementation of a rule that has moved repeatedly; the earlier local resolver showed a full awarded
 * amount right next to an "On hold" badge, disagreeing with both the web UI and the server's own totals.
 *
 * The local fallback below runs only for a payload without the field, and deliberately zeroes on the
 * stored `onHold`/`effectiveOnHold` flag so it errs toward the canonical answer rather than away from it.
 */
export function resolveDealValue(deal: ValueFields): number {
  if (typeof deal.effectiveValue === "number" && Number.isFinite(deal.effectiveValue)) {
    return deal.effectiveValue;
  }
  // Both hold signals, not just the effective one. On a payload predating these fields the badge falls
  // back to `onHold` and says "On hold" — so checking only `effectiveOnHold` here printed the full
  // amount directly beside that badge. Contradictory money and hold status is exactly what a
  // mixed-version deployment produces if the fallback is narrower than the badge.
  if (deal.effectiveOnHold === true || deal.onHold === true) return 0;

  const isEstimating = isGenuineEstimatingStage(deal.stageSlug, deal.workflowRoute);
  const candidates = isEstimating
    ? [deal.awardedAmount, deal.ddEstimate, deal.bidBoardTotalSales, deal.bidEstimate]
    : [deal.awardedAmount, deal.bidBoardTotalSales, deal.bidEstimate, deal.ddEstimate];

  for (const raw of candidates) {
    const value = parseFloat(raw ?? "0");
    if (Number.isFinite(value) && value > 0) return value;
  }
  return 0;
}

export function displayAmount(deal: ValueFields): string {
  const value = resolveDealValue(deal);
  return value > 0 ? formatMoney(value) : "—";
}

/**
 * At-risk is a SERVER verdict. The badge requires both status === "at_risk" and a severity other than
 * "none" — the flag alone is not sufficient, and recomputing the rule on device would drift from the web
 * app, which has changed it repeatedly.
 */
export function showsAtRisk(deal: Pick<DealListItem, "atRisk">): boolean {
  const r = deal.atRisk;
  return Boolean(r && r.isAtRisk && r.status === "at_risk" && r.severity !== "none");
}
