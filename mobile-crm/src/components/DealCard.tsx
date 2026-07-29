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
  // REQUIRED, not optional, because DealListItem declares it so. Every production caller passes a whole
  // DealListItem/DealDetail, and requiring it means a hand-built object that forgets the flag fails to
  // COMPILE rather than silently pricing a deductive change order at $0 on the fallback chain.
  | "isChangeOrder"
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

  /**
   * A change-order child deal's value is `awardedAmount` VERBATIM — never the `> 0` fallback chain.
   *
   * A CO child has no other value column to fall back to, and a DEDUCTIVE CO is NEGATIVE, so every
   * `> 0` candidate below would drop it to 0 and the phone would price a -$50,000 deduction at nothing.
   * Mirrors server deal-value-sql.ts withChangeOrderBranch, shared getRawDealValue and client
   * resolveBestEstimate — those three and this one MUST NOT drift. Gated on the FLAG, not on the sign:
   * an ordinary deal with a negative awarded amount still falls through the chain exactly as before.
   *
   * BELOW the hold check on purpose, matching SQL: storedOnHoldDealValueSql wraps the CO branch, so a
   * held deal is worth 0 whether or not it is a change order.
   */
  if (deal.isChangeOrder === true) {
    const awarded = parseFloat(deal.awardedAmount ?? "0");
    return Number.isFinite(awarded) ? awarded : 0;
  }

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

/**
 * The money as it appears on the card. Any NON-ZERO value renders; only zero shows the em dash.
 *
 * This gate used to be `> 0`, which threw away a correct answer: resolveDealValue already RECEIVES the
 * server's change-order-aware `effectiveValue`, so a deductive CO arrived here as -50000 and was drawn
 * as "—". The deduction was the one number that card existed to show.
 *
 * The dash still covers zero because resolveDealValue cannot tell "absent" from "explicitly $0" — both
 * collapse to the number 0 on the way out of it (a null column parses to 0; a held deal is zeroed; the
 * chain's own fallback is 0). Distinguishing them would mean changing that function's return type, and
 * the two read identically to a rep anyway. So zero keeps the pre-existing contract, and the ONLY
 * behaviour that changes is that a negative now renders as a negative.
 */
export function displayAmount(deal: ValueFields): string {
  const value = resolveDealValue(deal);
  return value !== 0 ? formatMoney(value) : "—";
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
      /* EVERYTHING the card shows, in the order it shows it.
         An explicit label REPLACES the text assembled from the children, so the name alone did not
         merely under-announce this card — it made the company, the amount, the location, the stage and
         both status badges UNREACHABLE. Two deals for the same company at the same stage were
         indistinguishable by ear, which is the failure BoardCard.tsx and LeadCard.tsx each already warn
         about in the same words; this was the third copy of the pattern and the one that missed.
         Built from the SAME values the JSX renders, so a line hidden because it is empty is absent
         here too. */
      accessibilityLabel={[
        deal.name ?? "Untitled deal",
        deal.companyName,
        displayAmount(deal),
        location,
        stageName,
        (deal.effectiveOnHold ?? deal.onHold) ? "On hold" : null,
        showsAtRisk(deal) ? "At risk" : null,
        deal.expectedCloseDate ? `Close ${formatDate(deal.expectedCloseDate)}` : null,
      ]
        .filter(Boolean)
        .join(", ")}
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
    minHeight: 44,
    justifyContent: "center",
    backgroundColor: theme.color.surface,
    borderRadius: theme.radius.lg,
    borderWidth: 1,
    borderColor: theme.color.border,
    padding: theme.space.lg,
    gap: theme.space.xs,
  },
  headerRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "flex-start", gap: theme.space.sm },
  name: { flex: 1, ...theme.type.title, color: theme.color.textPrimary },
  // h2 + tabular figures, matching BoardCard — the same deal must not look different depending on
  // which list it is in, and money that shifts width as it scrolls reads as noise.
  amount: { ...theme.type.h2, color: theme.color.textPrimary, fontVariant: ["tabular-nums"] },
  company: { ...theme.type.caption, color: theme.color.textMuted, textTransform: "uppercase" },
  meta: { ...theme.type.label, color: theme.color.textSecondary },
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
  stagePillText: { ...theme.type.caption, color: theme.color.textSecondary },
  // textSecondary, not textMuted: #8A95A3 on white is ~3:1, under the 4.5:1 floor for normal
  // text, and at 12px on a phone outdoors it is the first thing to become unreadable.
  closeDate: { ...theme.type.caption, color: theme.color.textSecondary },
});

/**
 * Memoised: the list re-renders on every keystroke in the search field, and without this each mounted
 * card re-rendered with identical props. Paired with a stable renderItem — memo is useless if the
 * callback identity changes every render.
 */
export const DealCard = React.memo(DealCardComponent);
