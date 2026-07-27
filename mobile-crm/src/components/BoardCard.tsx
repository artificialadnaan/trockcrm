import React from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import type { DealListItem } from "../api/types";
import { Badge } from "./Badge";
import { displayAmount, showsAtRisk } from "./DealCard";
import { theme } from "../theme/theme";

/**
 * A deal card as it appears in the pipeline — the board column and the full stage list behind it.
 *
 * Shared because those two screens show THE SAME deals, and a card that disagrees with itself between
 * the preview and the full list is worse than no full list at all: the rep sees a deal marked at-risk on
 * the board and unmarked one tap deeper, and has no way to tell which is lying. Every badge here comes
 * from a SERVER verdict (effectiveOnHold, atRisk, effectiveValue) precisely so there is one answer;
 * duplicating the component is how the two copies drift apart in the first place.
 */
/**
 * A soft-deleted (archived) deal is `is_active = false`, which is this app's canonical delete marker.
 *
 * The Lost column deliberately RETAINS these for reporting, so they appear on an all-time board — but
 * `getDealById` hides them by default (service.ts:2103), so tapping one opens a 404. Rendering them as
 * ordinary openable cards promises a screen that does not exist; they stay visible, because the column
 * counted them, and say what they are instead.
 */
function isArchived(deal: { isActive?: boolean | null }): boolean {
  return deal.isActive === false;
}

export function BoardCard({
  deal,
  canMove,
  onPress,
  testIDPrefix = "board-card",
}: {
  deal: DealListItem;
  /** Only the assigned rep may move a stage — see canMoveStage. */
  canMove: boolean;
  onPress: () => void;
  testIDPrefix?: string;
}) {
  const archived = isArchived(deal);

  return (
    <Pressable
      testID={`${testIDPrefix}-${deal.id}`}
      onPress={archived ? undefined : onPress}
      disabled={archived}
      accessibilityRole="button"
      accessibilityLabel={[deal.name ?? "Untitled deal", archived ? "Archived, can't be opened" : null]
        .filter(Boolean)
        .join(", ")}
      accessibilityState={{ disabled: archived }}
      style={[styles.card, archived && styles.cardArchived]}
    >
      <View style={styles.cardHead}>
        <Text style={styles.cardName} numberOfLines={1}>
          {deal.name ?? "Untitled deal"}
        </Text>
        <Text style={styles.cardAmount}>{displayAmount(deal)}</Text>
      </View>
      {deal.companyName ? (
        <Text style={styles.cardCompany} numberOfLines={1}>
          {deal.companyName}
        </Text>
      ) : null}
      <View style={styles.cardBadges}>
        {(deal.effectiveOnHold ?? deal.onHold) ? <Badge label="On hold" tone="amber" /> : null}
        {showsAtRisk(deal) ? <Badge label="At risk" tone="red" /> : null}
        {/* Marking the ones you CAN move is more useful than offering an action that 403s. */}
        {canMove && !archived ? <Text style={styles.yours}>Yours</Text> : null}
        {archived ? <Text style={styles.archived}>Archived</Text> : null}
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
  cardHead: { flexDirection: "row", justifyContent: "space-between", gap: theme.space.sm },
  cardName: { flex: 1, fontFamily: theme.font.bold, fontSize: 15, color: theme.color.inkNavy },
  cardAmount: { fontFamily: theme.font.bold, fontSize: 14, color: theme.color.textPrimary },
  cardCompany: { fontFamily: theme.font.semibold, fontSize: 13, color: theme.color.textSecondary },
  cardBadges: {
    flexDirection: "row",
    alignItems: "center",
    flexWrap: "wrap",
    gap: theme.space.sm,
    marginTop: theme.space.xs,
  },
  yours: { fontFamily: theme.font.semibold, fontSize: 12, color: theme.color.green },
  cardArchived: { opacity: 0.6 },
  archived: { fontFamily: theme.font.semibold, fontSize: 12, color: theme.color.textSecondary },
});
