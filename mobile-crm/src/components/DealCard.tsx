import React from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import type { DealListItem } from "../api/types";
import { Badge } from "./Badge";
import { displayAmount, showsAtRisk } from "../deal-value";
import { formatDate, formatLocation } from "../format";
import { theme } from "../theme/theme";

/**
 * THE deal card. One component for the deals list, the pipeline board, and the stage drill-down.
 *
 * There were two — `DealCard` for the list and `BoardCard` for the board — rendering the same
 * `DealListItem` in two visual languages. `BoardCard` put the name at `theme.type.title` (17) and the
 * amount at `theme.type.h2` (20) with tabular figures and a status rail; `DealCard` used literal 16 and
 * 15, a one-pixel difference between the two things a rep actually scans for, on the card reached from
 * Home and from the Deals tab. `BoardCard`'s own docblock already argued the case — "a card that
 * disagrees with itself between the preview and the full list is worse than no full list at all" — and
 * the third surface it did not cover was the one opened most.
 *
 * So the board's version won and the other was deleted, rather than being brought up to match. Two
 * components kept in agreement by review is a promise; one component is a fact.
 *
 * THE LIST NEEDS THREE THINGS THE BOARD DOES NOT, hence `variant`. On the board a column IS a stage and
 * every card in it shares one, so a stage pill would be noise repeated twelve times; the list is
 * cross-stage and the pill is the only thing saying where a deal sits. Location and close date are the
 * same shape of decision. Merging without them would have quietly dropped three fields from the list —
 * a redesign disguised as a refactor.
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
 *
 * Takes the already-resolved booleans rather than the deal: the caller computes `atRisk` and `onHold`
 * for the badges anyway, and re-deriving them here is how a rail ends up disagreeing with the chip
 * sitting two lines under it.
 */
function railColor(atRisk: boolean, onHold: boolean, archived: boolean): string {
  if (archived) return theme.color.borderSubtle;
  if (atRisk) return theme.color.brandRed;
  if (onHold) return theme.color.amber;
  return theme.color.borderStrong;
}

function DealCardComponent({
  deal,
  canMove,
  onPress,
  stageName,
  variant = "board",
  testIDPrefix = "board-card",
}: {
  deal: DealListItem;
  /** Only the assigned rep may move a stage — see canMoveStage. */
  canMove: boolean;
  /**
   * Takes the DEAL, so one handler serves a whole list.
   *
   * It used to take nothing, and both board screens passed `() => router.push(...)` inline — a fresh
   * closure per card per render, which is exactly what defeats the memo below. The list already had a
   * stable `handleDealPress(deal)`; this is that signature, so all three screens can hold one.
   */
  onPress: (deal: DealListItem) => void;
  /** The list is cross-stage and needs this; a board column already IS the stage. */
  stageName?: string;
  variant?: "board" | "list";
  testIDPrefix?: string;
}) {
  const archived = isArchived(deal);
  const atRisk = showsAtRisk(deal);
  const onHold = Boolean(deal.effectiveOnHold ?? deal.onHold);
  const isList = variant === "list";
  const location = isList ? formatLocation(deal.propertyCity, deal.propertyState) : null;
  const closeDate = isList && deal.expectedCloseDate ? formatDate(deal.expectedCloseDate) : null;

  return (
    <Pressable
      testID={`${testIDPrefix}-${deal.id}`}
      onPress={archived ? undefined : () => onPress(deal)}
      disabled={archived}
      accessibilityRole="button"
      /* The spoken label REPLACES the text assembled from the children, so anything omitted here becomes
         unreachable rather than merely unannounced — the company and the amount are why one card is
         distinguishable from the next. Built from the SAME values the JSX renders, so a line hidden
         because it is empty, or because this is the board, is absent here too. */
      accessibilityLabel={[
        deal.name ?? "Untitled deal",
        deal.companyName,
        displayAmount(deal),
        location,
        stageName,
        onHold ? "On hold" : null,
        atRisk ? "At risk" : null,
        // The "Yours" badge, which the JSX renders on the same condition. Left out, the one affordance
        // telling a rep this deal is theirs to move was visible and unreachable — the exact failure
        // this label was rebuilt to fix, missed on the badge added last.
        canMove && !archived ? "Yours" : null,
        archived ? "Archived, can't be opened" : null,
        closeDate ? `Close ${closeDate}` : null,
      ]
        .filter(Boolean)
        .join(", ")}
      accessibilityState={{ disabled: archived }}
      /**
       * TWO views, and the split is load-bearing on iOS.
       *
       * The outer one owns the shadow; the inner one owns `overflow: hidden`, which is what clips the
       * status rail to the card's rounded corner. On iOS a view with `overflow: "hidden"` clips its own
       * shadow as well, so having both on one view drew no shadow at all — the elevation this redesign
       * is built on would have been silently absent on the only platform this app ships to.
       */
      style={[styles.shadow, archived && styles.cardArchived]}
    >
      {({ pressed }: { pressed: boolean }) => (
        <View style={[styles.card, pressed && !archived && styles.cardPressed]}>
          <View style={[styles.rail, { backgroundColor: railColor(atRisk, onHold, archived) }]} />

          <View style={styles.body}>
            <View style={styles.cardHead}>
              <Text style={styles.cardName} numberOfLines={2}>
                {deal.name ?? "Untitled deal"}
              </Text>
              {/* The money is the second-loudest thing on the card, after the name. It was 14px
                  semibold sitting level with every other line, which is not how anyone reads a
                  pipeline. */}
              <Text style={styles.cardAmount} numberOfLines={1}>
                {displayAmount(deal)}
              </Text>
            </View>

            {deal.companyName ? (
              /* Uppercased by STYLE and labelled explicitly — on iOS the transform is applied before
                 the attributed string is built, so without the label VoiceOver spells the company out.
                 See uppercase-text-has-accessible-label.test.ts. Redundant while the parent Pressable
                 carries its own label and groups this subtree, and kept anyway: the day someone renders
                 this line outside a labelled group, the guard should not have to be re-derived. */
              <Text
                accessibilityLabel={deal.companyName}
                style={styles.cardCompany}
                numberOfLines={1}
              >
                {deal.companyName}
              </Text>
            ) : null}

            {location ? (
              <Text style={styles.cardMeta} numberOfLines={1}>
                {location}
              </Text>
            ) : null}

            {onHold || atRisk || canMove || archived || stageName || closeDate ? (
              <View style={styles.cardBadges}>
                {stageName ? (
                  <View style={styles.stagePill}>
                    <Text style={styles.stagePillText}>{stageName}</Text>
                  </View>
                ) : null}
                {onHold ? <Badge label="On hold" tone="amber" /> : null}
                {atRisk ? <Badge label="At risk" tone="red" /> : null}
                {/* Marking the ones you CAN move is more useful than offering an action that 403s. */}
                {canMove && !archived ? <Badge label="Yours" tone="green" /> : null}
                {archived ? <Badge label="Archived" tone="neutral" /> : null}
                {closeDate ? <Text style={styles.closeDate}>Close {closeDate}</Text> : null}
              </View>
            ) : null}
          </View>
        </View>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  /**
   * SHADOW ONLY, and deliberately no `overflow` — see the note on the Pressable.
   *
   * borderRadius is repeated here so the shadow is cast in the card's actual silhouette rather than as
   * a rectangle behind a rounded card.
   */
  shadow: {
    minHeight: 44,
    justifyContent: "center",
    borderRadius: theme.radius.lg,
    ...theme.elevation.card,
  },
  card: {
    flexDirection: "row",
    backgroundColor: theme.color.surface,
    borderRadius: theme.radius.lg,
    borderWidth: 1,
    borderColor: theme.color.border,
    // Clips the status rail to the rounded corner. Safe here because this view casts no shadow.
    overflow: "hidden",
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
  cardCompany: { ...theme.type.caption, color: theme.color.textMuted, textTransform: "uppercase" },
  cardMeta: { ...theme.type.label, color: theme.color.textSecondary },
  cardBadges: {
    flexDirection: "row",
    alignItems: "center",
    flexWrap: "wrap",
    gap: theme.space.sm,
    marginTop: 2,
  },
  stagePill: {
    backgroundColor: theme.color.surfaceMuted,
    borderWidth: 1,
    borderColor: theme.color.border,
    borderRadius: theme.radius.sm,
    paddingHorizontal: theme.space.md,
    paddingVertical: 3,
  },
  stagePillText: { ...theme.type.caption, color: theme.color.textSecondary },
  // textSecondary, not textMuted: textMuted sits at 4.99:1 on `surface` and this is the smallest text
  // on the card, which outdoors is the first thing to become unreadable.
  closeDate: { ...theme.type.caption, color: theme.color.textSecondary },
  cardArchived: { opacity: 0.55 },
});

/**
 * Memoised: the list re-renders on every keystroke in the search field, and without this each mounted
 * card re-rendered with identical props. Paired with a stable renderItem — memo is useless if the
 * callback identity changes every render, which is why `onPress` takes the deal.
 */
export const DealCard = React.memo(DealCardComponent);
