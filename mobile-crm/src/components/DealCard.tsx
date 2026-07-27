import React from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import type { DealListItem, PipelineStage } from "../api/types";
import { Badge } from "./Badge";
import { formatDate, formatLocation, formatMoney } from "../format";
import { theme } from "../theme/theme";

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

function DealCardComponent({
  deal,
  stageName,
  onPress,
}: {
  deal: DealListItem;
  stageName?: string;
  onPress: (deal: DealListItem) => void;
}) {
  const location = formatLocation(deal.propertyCity, deal.propertyState);

  return (
    <Pressable
      testID={`deal-card-${deal.id}`}
      onPress={() => onPress(deal)}
      accessibilityRole="button"
      accessibilityLabel={deal.name ?? "Untitled deal"}
      style={styles.card}
    >
      <View style={styles.headerRow}>
        <Text style={styles.name} numberOfLines={1}>
          {deal.name ?? "Untitled deal"}
        </Text>
        <Text style={styles.amount}>{displayAmount(deal)}</Text>
      </View>

      {deal.companyName ? (
        <Text style={styles.company} numberOfLines={1}>
          {deal.companyName}
        </Text>
      ) : null}

      {location ? (
        <Text style={styles.meta} numberOfLines={1}>
          {location}
        </Text>
      ) : null}

      <View style={styles.badgeRow}>
        {stageName ? (
          <View style={styles.stagePill}>
            <Text style={styles.stagePillText}>{stageName}</Text>
          </View>
        ) : null}
        {/* The EFFECTIVE flag, so the badge and the $0 always agree — a deal auto-parked by a
            far-future close target is held even though `onHold` is false. */}
        {(deal.effectiveOnHold ?? deal.onHold) ? (
          <Badge label="On hold" tone="amber" />
        ) : null}
        {showsAtRisk(deal) ? (
          <Badge label="At risk" tone="red" />
        ) : null}
        {deal.expectedCloseDate ? (
          <Text style={styles.closeDate}>Close {formatDate(deal.expectedCloseDate)}</Text>
        ) : null}
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: theme.color.surface,
    borderRadius: theme.radius.lg,
    borderWidth: 1,
    borderColor: theme.color.border,
    padding: theme.space.lg,
    gap: theme.space.xs,
  },
  headerRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "flex-start", gap: theme.space.sm },
  name: { flex: 1, fontFamily: theme.font.bold, fontSize: 16, color: theme.color.inkNavy },
  amount: { fontFamily: theme.font.bold, fontSize: 15, color: theme.color.textPrimary },
  company: { fontFamily: theme.font.semibold, fontSize: 14, color: theme.color.textSecondary },
  meta: { fontFamily: theme.font.regular, fontSize: 13, color: theme.color.textMuted },
  badgeRow: {
    flexDirection: "row",
    alignItems: "center",
    flexWrap: "wrap",
    gap: theme.space.sm,
    marginTop: theme.space.xs,
  },
  stagePill: {
    backgroundColor: theme.color.surfaceMuted,
    borderRadius: theme.radius.pill,
    paddingHorizontal: theme.space.md,
    paddingVertical: 3,
  },
  stagePillText: { fontFamily: theme.font.semibold, fontSize: 12, color: theme.color.textSecondary },
  closeDate: { fontFamily: theme.font.regular, fontSize: 12, color: theme.color.textMuted },
});

/**
 * Memoised: the list re-renders on every keystroke in the search field, and without this each mounted
 * card re-rendered with identical props. Paired with a stable renderItem — memo is useless if the
 * callback identity changes every render.
 */
export const DealCard = React.memo(DealCardComponent);
