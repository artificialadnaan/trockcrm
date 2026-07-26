import React from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import type { DealListItem, PipelineStage } from "../api/types";
import { formatDate, formatLocation, formatMoney } from "../format";
import { theme } from "../theme/theme";

type ValueFields = Pick<
  DealListItem,
  "awardedAmount" | "bidEstimate" | "ddEstimate" | "bidBoardTotalSales" | "stageSlug" | "workflowRoute"
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
 * Testing `stageSlug === "estimating"` alone misclassified every deal still carrying the supported
 * legacy `estimate_in_progress` alias, showing a LOWER value on mobile than the web app shows.
 */
export function isGenuineEstimatingStage(
  stageSlug: string | null | undefined,
  workflowRoute: string | null | undefined,
): boolean {
  if (workflowRoute === "service") return false;
  return Boolean(stageSlug && ESTIMATING_STAGE_SLUGS.has(stageSlug));
}

/**
 * The canonical deal value, mirroring client/src/lib/deal-utils.ts resolveBestEstimate.
 *
 * FOUR money columns participate, not two, and each candidate must be > 0 — a stored "0.00" is not a
 * value. The order is normally awarded > bid_board > bid > dd, but on the genuine `estimating` stage DD
 * OUTRANKS the in-progress bid: awarded > dd > bid_board > bid.
 *
 * Considering only awarded and bid — as this first did — showed a lower number, or "—", on every
 * estimating and Bid Board deal that had a tracked value. Wrong money on a sales tool is worse than none.
 */
export function resolveDealValue(deal: ValueFields): number {
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

export function DealCard({
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
        {deal.onHold ? (
          <View style={[styles.pill, styles.holdPill]}>
            <Text style={styles.holdPillText}>On hold</Text>
          </View>
        ) : null}
        {showsAtRisk(deal) ? (
          <View style={[styles.pill, styles.riskPill]}>
            <Text style={styles.riskPillText}>At risk</Text>
          </View>
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
  pill: { borderRadius: theme.radius.pill, paddingHorizontal: theme.space.md, paddingVertical: 3 },
  holdPill: { backgroundColor: "#FEF3C7" },
  holdPillText: { fontFamily: theme.font.semibold, fontSize: 12, color: "#92400E" },
  riskPill: { backgroundColor: "#FEE2E2" },
  riskPillText: { fontFamily: theme.font.semibold, fontSize: 12, color: theme.color.brandRedDeep },
  closeDate: { fontFamily: theme.font.regular, fontSize: 12, color: theme.color.textMuted },
});
