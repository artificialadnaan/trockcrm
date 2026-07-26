import React from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import type { DealListItem, PipelineStage } from "../api/types";
import { formatDate, formatLocation, formatMoney } from "../format";
import { theme } from "../theme/theme";

/**
 * The best available amount for a list row.
 *
 * A deal carries several money columns and which one is meaningful depends on how far along it is: an
 * awarded amount only exists once it is won, so a bid estimate is the honest number before that. Showing
 * "—" on a deal that has an estimate would read as "no value", which is a different claim.
 */
export function displayAmount(deal: Pick<DealListItem, "awardedAmount" | "bidEstimate">): string {
  return formatMoney(deal.awardedAmount ?? deal.bidEstimate);
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
