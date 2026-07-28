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

/**
 * The card's status rail — the 3px stripe down its leading edge.
 *
 * At-risk outranks on-hold because it is the one that needs action today. This is the only place status
 * is encoded at CARD scale rather than chip scale: scanning a column of twelve, the rail is legible in
 * peripheral vision where an 11px chip is not, and it survives being read at arm's length in sunlight.
 * It also encodes status as position + colour, so it does not depend on hue alone.
 */
function railColor(deal: DealListItem, archived: boolean): string {
  if (archived) return theme.color.borderSubtle;
  if (showsAtRisk(deal)) return theme.color.brandRed;
  if (deal.effectiveOnHold ?? deal.onHold) return theme.color.amber;
  return theme.color.borderStrong;
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
  const atRisk = showsAtRisk(deal);
  const onHold = Boolean(deal.effectiveOnHold ?? deal.onHold);

  return (
    <Pressable
      testID={`${testIDPrefix}-${deal.id}`}
      onPress={archived ? undefined : onPress}
      disabled={archived}
      accessibilityRole="button"
      /* The spoken label REPLACES the text assembled from the children, so anything omitted here becomes
         unreachable rather than merely unannounced — the company and the amount are why one card is
         distinguishable from the next. */
      accessibilityLabel={[
        deal.name ?? "Untitled deal",
        deal.companyName,
        displayAmount(deal),
        onHold ? "On hold" : null,
        atRisk ? "At risk" : null,
        archived ? "Archived, can't be opened" : null,
      ]
        .filter(Boolean)
        .join(", ")}
      accessibilityState={{ disabled: archived }}
      style={({ pressed }) => [
        styles.card,
        pressed && !archived && styles.cardPressed,
        archived && styles.cardArchived,
      ]}
    >
      <View style={[styles.rail, { backgroundColor: railColor(deal, archived) }]} />

      <View style={styles.body}>
        <View style={styles.cardHead}>
          <Text style={styles.cardName} numberOfLines={2}>
            {deal.name ?? "Untitled deal"}
          </Text>
          {/* The money is the second-loudest thing on the card, after the name. It was 14px semibold
              sitting level with every other line, which is not how anyone reads a pipeline. */}
          <Text style={styles.cardAmount} numberOfLines={1}>
            {displayAmount(deal)}
          </Text>
        </View>

        {deal.companyName ? (
          <Text style={styles.cardCompany} numberOfLines={1}>
            {deal.companyName.toUpperCase()}
          </Text>
        ) : null}

        {onHold || atRisk || canMove || archived ? (
          <View style={styles.cardBadges}>
            {onHold ? <Badge label="On hold" tone="amber" /> : null}
            {atRisk ? <Badge label="At risk" tone="red" /> : null}
            {/* Marking the ones you CAN move is more useful than offering an action that 403s. */}
            {canMove && !archived ? <Badge label="Yours" tone="green" /> : null}
            {archived ? <Badge label="Archived" tone="neutral" /> : null}
          </View>
        ) : null}
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: {
    flexDirection: "row",
    backgroundColor: theme.color.surface,
    borderRadius: theme.radius.lg,
    borderWidth: 1,
    borderColor: theme.color.border,
    // overflow hidden so the rail is clipped by the card's own radius rather than poking past the corner.
    overflow: "hidden",
    ...theme.elevation.card,
  },
  // A real pressed state. Nothing acknowledged a touch before, so on a slow network a tap looked ignored
  // and reps tapped again — which on the move screen is how a double-submit starts.
  cardPressed: { backgroundColor: theme.color.surfaceRaised, borderColor: theme.color.borderStrong },
  rail: { width: 3 },
  body: { flex: 1, padding: theme.space.lg, gap: 6 },
  cardHead: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "flex-start",
    gap: theme.space.md,
  },
  cardName: { flex: 1, ...theme.type.title, color: theme.color.textPrimary },
  cardAmount: {
    ...theme.type.h2,
    color: theme.color.textPrimary,
    // Tabular figures so a column of amounts aligns digit-for-digit instead of shimmering as it scrolls.
    fontVariant: ["tabular-nums"],
  },
  cardCompany: { ...theme.type.caption, color: theme.color.textMuted },
  cardBadges: {
    flexDirection: "row",
    alignItems: "center",
    flexWrap: "wrap",
    gap: theme.space.sm,
    marginTop: 2,
  },
  cardArchived: { opacity: 0.55 },
});
