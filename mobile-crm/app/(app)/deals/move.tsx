import React, { useMemo, useState } from "react";
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { SafeAreaView } from "react-native-safe-area-context";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ApiError } from "../../../src/api/client";
import * as dealsApi from "../../../src/api/endpoints/deals";
import * as pipelineApi from "../../../src/api/endpoints/pipeline";
import { useAuth } from "../../../src/auth/AuthContext";
import { useQueryScope } from "../../../src/auth/useOfficeId";
import { RetryBlock } from "../../../src/components/RetryBlock";
import { RetryNotice } from "../../../src/components/RetryNotice";
import { qk } from "../../../src/query/keys";
import {
  businessDateInDays,
  businessTodayDateStr,
  isExpectedCloseDateSoleGateBlocker,
  isGateResolvedByInlineCloseDate,
  isUsableCloseDate,
} from "../../../src/inline-close-date";
import { eligibleStageTargets } from "../../../src/stage-targets";
import { theme } from "../../../src/theme/theme";

/**
 * Move a deal to another stage.
 *
 * Two-step by design: preflight tells the rep exactly what is missing BEFORE anything changes, instead
 * of handing them an opaque 400 afterwards. That is the whole reason the server exposes a preflight.
 *
 * THE TRAP THIS SCREEN EXISTS TO AVOID: preflight has no ownership check, while the commit route is
 * strictly owner-only with no admin or director bypass. So `allowed: true` does NOT mean this user may
 * commit — a director can preflight any deal in their office, see a green light, and take a hard 403.
 * Ownership is checked here first, and a non-owner is told plainly rather than being walked into a
 * failure at the last step.
 */

/**
 * Slugs the STAGE-CHANGE ROUTE treats as a Lost outcome — the only ones for which it requires a reason
 * id and non-blank notes, and the only ones for which it stores them.
 *
 * Mirrors `isLostOutcomeStage` in server/src/modules/deals/stage-change.ts:74-80, resolved through
 * `toCanonicalTerminalOutcomeSlug` (same file, :44-70). This app cannot import shared (it is deliberately
 * not an npm workspace), so it is a mirror — and getting the mirror right has taken three attempts, each
 * failing differently:
 *
 *   1. All four legacy aliases, omitting the canonical "lost" — so the screen stayed silent on the slug
 *      current pipelines actually use, and the server rejected the move naming fields the rep never saw.
 *   2. Anchored to LOST_DEAL_STAGE_SLUGS (shared/src/types/workflow.ts:313-315). That constant is the
 *      REPORTING classification set — "does this deal count as lost" — and it is deliberately wider,
 *      because historical HubSpot-imported rows carry `deal_canceled` and must still tally as losses.
 *      The stage-change ROUTE does not accept that slug as a Lost outcome, so prompting on it collected
 *      a reason and notes the server then dropped on the floor.
 *
 * The two sets differ on exactly one slug, and only one of them is a request contract. Anchor here.
 *
 * `deal_canceled` is therefore absent ON PURPOSE. It is seeded by no migration and belongs to no live
 * pipeline; it exists so old rows read correctly. Note the web dialog does prompt on it — it derives the
 * flag from the canonical mapping — and has its details discarded just the same. That is a pre-existing
 * server-side gap, not a mobile one, and closing it would make the route start rejecting moves that
 * succeed today, so it is not something to fix from here.
 */
const LOST_SLUGS = new Set([
  "lost",
  "production_lost",
  "service_lost",
  "closed_lost",
]);

/** Common forecast horizons. Deliberately short of 90 days — past that the deal auto-parks as held. */
const QUICK_CLOSE_DATES = [
  { label: "2 weeks", days: 14 },
  { label: "30 days", days: 30 },
  { label: "60 days", days: 60 },
];

export default function MoveStageScreen() {
  const { dealId: rawId } = useLocalSearchParams<{ dealId: string }>();
  const dealId = typeof rawId === "string" ? rawId : "";
  const router = useRouter();
  const { session, fetcher } = useAuth();
  const scope = useQueryScope();
  const queryClient = useQueryClient();

  const [targetStageId, setTargetStageId] = useState<string | null>(null);
  const [overrideReason, setOverrideReason] = useState("");
  const [lostReasonId, setLostReasonId] = useState<string | null>(null);
  const [lostNotes, setLostNotes] = useState("");
  const [expectedCloseDate, setExpectedCloseDate] = useState("");
  const [submitError, setSubmitError] = useState<string | null>(null);

  const dealQuery = useQuery({
    queryKey: qk.deal(scope, dealId),
    queryFn: () => dealsApi.getDealDetail(fetcher, dealId),
    enabled: dealId.length > 0,
  });

  const stagesQuery = useQuery({
    queryKey: qk.stages(scope),
    queryFn: () => dealsApi.listStages(fetcher),
    staleTime: 30 * 60_000,
  });

  const preflight = useQuery({
    queryKey: ["stage-preflight", scope, dealId, targetStageId],
    queryFn: () => pipelineApi.preflightStage(fetcher, dealId, targetStageId as string),
    enabled: Boolean(dealId && targetStageId),
    /**
     * ALWAYS STALE. The key names the user, deal and target — none of which change when the DEAL does,
     * yet the verdict is computed entirely from the deal's current stage and gate state. Under the
     * app-wide 60s staleTime, preflighting several targets, committing one, and reopening this screen
     * served the pre-move verdict for the others: a move that is now BACKWARD reads as ready and its
     * override input never appears, until the server rejects the commit.
     *
     * A verdict is a statement about a moment. Caching it past that moment is caching an answer to a
     * question nobody asked.
     */
    staleTime: 0,
    gcTime: 0,
  });

  const lostReasons = useQuery({
    // SCOPED BY OFFICE. Lost reasons are tenant rows and offices are separate Postgres schemas, so the
    // ids are only meaningful inside the office that issued them. Cached under a bare key with a
    // one-hour staleTime, a multi-office rep who switched offices kept being offered the PREVIOUS
    // office's reasons — submitting one then either 400s or, if the ids happen to collide, silently
    // records the wrong reason. The fetcher already sends the new office header; only the key lagged.
    queryKey: ["lost-reasons", scope],
    queryFn: () => pipelineApi.listLostReasons(fetcher),
    staleTime: 60 * 60_000,
    // Only fetched once a Lost target is actually selected — it is a different router mount and most
    // moves never need it.
    enabled: Boolean(targetStage(stagesQuery.data, targetStageId)?.slug &&
      LOST_SLUGS.has(targetStage(stagesQuery.data, targetStageId)!.slug)),
  });

  const deal = dealQuery.data;
  const stages = stagesQuery.data ?? [];
  const target = targetStage(stages, targetStageId);
  const isLostMove = Boolean(target && LOST_SLUGS.has(target.slug));

  // OWNERSHIP, not the preflight verdict. See the module note above.
  const isOwner = deal ? pipelineApi.canMoveStage(deal, session?.user.id) : false;
  const moveLock = deal ? pipelineApi.stageMoveLock(deal) : ({ locked: false } as const);

  const verdict = preflight.data;
  const needsOverride = Boolean(verdict?.requiresOverride);
  const blocked = Boolean(verdict && !verdict.allowed);

  /**
   * The gate must have ANSWERED, not merely stopped asking.
   *
   * `blocked` is derived from `verdict`, so when preflight fails — offline, 500, timeout — `verdict` is
   * undefined and `blocked` is false. Read as "not blocked", that enabled Confirm the moment the spinner
   * stopped, offering a two-step confirmation whose first step never happened. The commit route does
   * revalidate, so nothing invalid gets written; the cost is that a rep is walked past the explanation
   * this screen exists to give and handed the raw 400 instead.
   *
   * Absence of an answer is not a permissive answer. Same shape as the never-loaded-vs-empty rule in
   * src/list-state.ts, which is where this app keeps getting caught: `undefined` is not `false`.
   */
  const preflightAnswered = verdict !== undefined;

  /**
   * The inline close-date gate — the one blocker this screen can clear itself.
   *
   * Without it, a stage advance whose ONLY missing requirement is expectedCloseDate was a dead end on
   * mobile: the field was listed, Confirm stayed disabled, and there is no deal-edit path in this app to
   * go and set it. The server accepts the date in the same POST and revalidates against it, which is how
   * the web resolves the same gate in one action.
   */
  const closeDateGate = {
    missingRequirements: verdict?.missingRequirements,
    isBackwardMove: verdict?.isBackwardMove,
    currentStageSlug: verdict?.currentStage?.slug,
    bidBoardLocked: verdict?.bidBoardLocked,
  };
  const today = businessTodayDateStr();
  const needsCloseDate = isExpectedCloseDateSoleGateBlocker(closeDateGate);
  const closeDateResolvesGate = isGateResolvedByInlineCloseDate(closeDateGate, expectedCloseDate, today);
  const closeDateInvalid = expectedCloseDate.length > 0 && !isUsableCloseDate(expectedCloseDate, today);

  const canSubmit =
    !moveLock.locked &&
    isOwner &&
    Boolean(targetStageId) &&
    preflightAnswered &&
    // A blocked verdict still passes when the inline date is the sole blocker AND a usable value is in
    // hand — the POST revalidates with it, so the stale verdict must not veto its own remedy.
    (!blocked || closeDateResolvesGate) &&
    (!needsCloseDate || closeDateResolvesGate) &&
    // Preflight computed requiresOverride BEFORE this date existed; when the date alone clears the gate
    // the server no longer wants an override, so demanding one here would block a move it would accept.
    (!needsOverride || closeDateResolvesGate || overrideReason.trim().length > 0) &&
    (!isLostMove || (Boolean(lostReasonId) && lostNotes.trim().length > 0)) &&
    !preflight.isFetching;

  const move = useMutation({
    mutationFn: () =>
      pipelineApi.moveStage(fetcher, dealId, {
        targetStageId: targetStageId as string,
        overrideReason: needsOverride ? overrideReason.trim() : undefined,
        lostReasonId: isLostMove ? (lostReasonId as string) : undefined,
        lostNotes: isLostMove ? lostNotes.trim() : undefined,
        expectedCloseDate: needsCloseDate && closeDateResolvesGate ? expectedCloseDate : undefined,
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: qk.deal(scope, dealId) });
      await queryClient.invalidateQueries({ queryKey: ["deals", scope] });
      await queryClient.invalidateQueries({ queryKey: ["pipeline", scope] });
      // The stage drill-down too. It is a SIBLING route that stays mounted underneath this screen when
      // the move was started from it, so returning goes to a cached list still showing the deal in the
      // stage it just left — and the destination stage's cached list missing it. Neither key above
      // matches ["stage-deals", ...], so without this the rep is looking at a board that disagrees with
      // the move they just made.
      await queryClient.invalidateQueries({ queryKey: ["stage-deals", scope] });
      router.back();
    },
    onError: async (err) => {
      // A dropped connection on a POST is INDETERMINATE, not a rollback. The request may have reached
      // the server and committed with only the response lost, so "Nothing was changed" is a claim this
      // client is not in a position to make — and a rep who believes it will move the deal a second
      // time. Say what is actually known, and refresh so the screen behind shows whichever way it went.
      if (err instanceof ApiError && err.status === 0) {
        setSubmitError(
          "Lost connection before the server answered — the move may or may not have gone through. " +
            "Check the deal's stage before trying again.",
        );
        await queryClient.invalidateQueries({ queryKey: qk.deal(scope, dealId) });
        await queryClient.invalidateQueries({ queryKey: ["deals", scope] });
        await queryClient.invalidateQueries({ queryKey: ["pipeline", scope] });
        await queryClient.invalidateQueries({ queryKey: ["stage-deals", scope] });
        return;
      }
      setSubmitError(err instanceof ApiError ? err.message : "Couldn't move the deal.");
    },
  });

  if (dealQuery.isLoading) {
    return (
      <SafeAreaView style={styles.safe}>
        <View style={styles.center}>
          <ActivityIndicator color={theme.color.brandRed} />
        </View>
      </SafeAreaView>
    );
  }

  if (!deal) {
    return (
      <SafeAreaView style={styles.safe}>
        <View style={styles.center}>
          <Text style={styles.title}>Couldn&apos;t load this deal</Text>
          <Pressable onPress={() => router.back()} accessibilityRole="button" style={styles.secondary}>
            <Text style={styles.secondaryText}>Go back</Text>
          </Pressable>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.safe} edges={["top"]}>
      <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === "ios" ? "padding" : undefined}>
        <ScrollView contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled">
          <Pressable onPress={() => router.back()} accessibilityRole="button">
            <Text style={styles.back}>‹ Cancel</Text>
          </Pressable>

          <Text style={styles.title}>Move stage</Text>
          <Text style={styles.subtitle} numberOfLines={2}>
            {deal.name ?? "Untitled deal"}
          </Text>

          {moveLock.locked ? (
            /* Ahead of ownership, because this is a property of the DEAL: nobody can move it, so telling
               the rep "only the assigned rep can" would be both wrong and useless. The commit route
               rejects it with a 409 CHANGE_ORDER_STAGE_LOCKED while preflight happily reports the move
               as ready — the same shape as the ownership trap this screen exists to prevent. */
            <View testID="move-locked" style={styles.blockBox}>
              <Text style={styles.blockTitle}>{moveLock.title}</Text>
              <Text style={styles.blockBody}>{moveLock.body}</Text>
            </View>
          ) : !isOwner ? (
            /* Said up front rather than after a failed commit. Only the assigned rep can move a deal —
               there is no admin or director bypass on this route, which surprises people who have one
               everywhere else. */
            <View testID="not-owner" style={styles.blockBox}>
              <Text style={styles.blockTitle}>Only the assigned rep can move this deal</Text>
              <Text style={styles.blockBody}>
                {deal.assignedRepName
                  ? `It's assigned to ${deal.assignedRepName}. Ask them to move it, or have it reassigned first.`
                  : "It isn't assigned to you. Have it reassigned first."}
              </Text>
            </View>
          ) : null}

          <Text style={styles.label}>Move to</Text>
          {stagesQuery.isLoading ? (
            <ActivityIndicator color={theme.color.brandRed} />
          ) : stagesQuery.isError && stagesQuery.data === undefined ? (
            /* A failed stages load used to fall through `?? []` and render as a legitimately empty
               menu — indistinguishable from "this pipeline has no other stages", with no error and no
               way back short of remounting the screen. Every move starts by picking one of these, so
               swallowing the failure takes the whole feature offline silently.

               BLOCKING ONLY WHEN NOTHING IS CACHED. `isError` alone also fires when a background
               refetch of already-loaded stages fails, and that tore a perfectly usable menu off the
               screen and replaced it with an error — turning a harmless refresh blip into an outage.
               Same `data === undefined` rule as src/list-state.ts, which exists for exactly this and
               which I did not apply when writing these two branches. */
            <RetryBlock
              testID="stages-error"
              title="Couldn't load the stages"
              onRetry={() => void stagesQuery.refetch()}
              retrying={stagesQuery.isFetching}
            />
          ) : (
            <>
            {stagesQuery.isError ? (
              <RetryNotice
                testID="stages-refresh-retry"
                message="Couldn't refresh the stages — showing the saved list. Tap to retry."
                onRetry={() => void stagesQuery.refetch()}
                placement="top"
              />
            ) : null}
            <View style={styles.stageGrid}>
              {eligibleStageTargets(stages, deal).map((s) => (
                <Pressable
                  key={s.id}
                  testID={`move-target-${s.slug}`}
                  onPress={() => {
                    setTargetStageId(s.id);
                    setSubmitError(null);
                  }}
                  disabled={!isOwner || moveLock.locked}
                  accessibilityRole="button"
                  accessibilityState={{ selected: targetStageId === s.id, disabled: !isOwner || moveLock.locked }}
                  style={[
                    styles.stageOption,
                    targetStageId === s.id && styles.stageOptionActive,
                    (!isOwner || moveLock.locked) && styles.stageOptionDisabled,
                  ]}
                >
                  <Text
                    style={[styles.stageOptionText, targetStageId === s.id && styles.stageOptionTextActive]}
                  >
                    {s.name}
                  </Text>
                </Pressable>
              ))}
            </View>
            </>
          )}

          {preflight.isFetching ? (
            <View style={styles.checkingRow}>
              <ActivityIndicator color={theme.color.brandRed} />
              <Text style={styles.checkingText}>Checking requirements…</Text>
            </View>
          ) : null}

          {targetStageId && !preflight.isFetching && preflight.isError ? (
            /* A preflight that FAILED renders nothing otherwise: `verdict` stays undefined, so the
               verdict box below never appears, while `preflightAnswered` keeps Confirm disabled. The rep
               is left with a dead button and no explanation — and cannot even retry by re-tapping the
               target, because the query key does not change when the same stage is selected again. */
            <RetryBlock
              testID="preflight-error"
              title="Couldn't check the requirements"
              body="Nothing has changed on the deal. Try again to see whether this move is allowed."
              onRetry={() => void preflight.refetch()}
              retrying={preflight.isFetching}
            />
          ) : null}

          {verdict ? (
            <View style={styles.verdictBox}>
              {verdict.bidBoardLocked ? (
                <Text style={styles.blockTitle}>This deal is managed on the Bid Board</Text>
              ) : blocked ? (
                <Text style={styles.blockTitle}>Can&apos;t move yet</Text>
              ) : verdict.isBackwardMove ? (
                <Text style={styles.warnTitle}>This moves the deal backwards</Text>
              ) : (
                <Text style={styles.okTitle}>Ready to move</Text>
              )}

              {verdict.blockReason ? <Text style={styles.blockBody}>{verdict.blockReason}</Text> : null}

              <MissingList verdict={verdict} />
            </View>
          ) : null}

          {isOwner && needsCloseDate ? (
            <>
              <Text style={styles.label}>Expected close date</Text>
              <Text style={styles.help}>
                This is the only thing holding the move up. Set it here and the deal advances in one step.
              </Text>
              {/* Quick picks first: on a phone, on a ladder, three taps of a chip beats typing ten
                  digits, and these cover the common forecasts. The field stays for an exact date. */}
              <View style={styles.stageGrid}>
                {QUICK_CLOSE_DATES.map((pick) => {
                  const value = businessDateInDays(pick.days);
                  return (
                    <Pressable
                      key={pick.label}
                      testID={`close-date-${pick.days}`}
                      onPress={() => setExpectedCloseDate(value)}
                      accessibilityRole="button"
                      accessibilityLabel={`${pick.label}, ${value}`}
                      accessibilityState={{ selected: expectedCloseDate === value }}
                      style={[styles.stageOption, expectedCloseDate === value && styles.stageOptionActive]}
                    >
                      <Text
                        style={[
                          styles.stageOptionText,
                          expectedCloseDate === value && styles.stageOptionTextActive,
                        ]}
                      >
                        {pick.label}
                      </Text>
                    </Pressable>
                  );
                })}
              </View>
              <TextInput
                testID="expected-close-date"
                value={expectedCloseDate}
                onChangeText={setExpectedCloseDate}
                placeholder="YYYY-MM-DD"
                placeholderTextColor={theme.color.textMuted}
                autoCapitalize="none"
                autoCorrect={false}
                keyboardType={Platform.OS === "ios" ? "numbers-and-punctuation" : "default"}
                style={styles.input}
              />
              {closeDateInvalid ? (
                <Text testID="close-date-invalid" style={styles.error}>
                  Use a real date of today or later, written as YYYY-MM-DD.
                </Text>
              ) : null}
            </>
          ) : null}

          {isOwner && needsOverride && !closeDateResolvesGate ? (
            <>
              <Text style={styles.label}>Reason for the override</Text>
              <Text style={styles.help}>
                This move skips a requirement, so the reason is recorded on the deal&apos;s history.
              </Text>
              <TextInput
                testID="override-reason"
                value={overrideReason}
                onChangeText={setOverrideReason}
                placeholder="Why is this moving anyway?"
                placeholderTextColor={theme.color.textMuted}
                multiline
                style={styles.input}
              />
            </>
          ) : null}

          {isOwner && isLostMove ? (
            <>
              <Text style={styles.label}>Why was it lost?</Text>
              {lostReasons.isLoading ? (
                <ActivityIndicator color={theme.color.brandRed} />
              ) : lostReasons.isError && lostReasons.data === undefined ? (
                /* A Lost move cannot be submitted without a reason id, so a failed lookup rendered as an
                   empty grid left Confirm permanently disabled with nothing on screen explaining why —
                   the rep sees a button that simply does not work. Blocking only when nothing is
                   cached, for the same reason as the stage menu above. */
                <RetryBlock
                  testID="lost-reasons-error"
                  title="Couldn't load the lost reasons"
                  onRetry={() => void lostReasons.refetch()}
                  retrying={lostReasons.isFetching}
                />
              ) : (
                <View style={styles.stageGrid}>
                  {(lostReasons.data ?? []).map((r) => (
                    <Pressable
                      key={r.id}
                      testID={`lost-reason-${r.id}`}
                      onPress={() => setLostReasonId(r.id)}
                      accessibilityRole="button"
                      accessibilityState={{ selected: lostReasonId === r.id }}
                      style={[styles.stageOption, lostReasonId === r.id && styles.stageOptionActive]}
                    >
                      <Text
                        style={[
                          styles.stageOptionText,
                          lostReasonId === r.id && styles.stageOptionTextActive,
                        ]}
                      >
                        {r.label}
                      </Text>
                    </Pressable>
                  ))}
                </View>
              )}
              <Text style={styles.label}>What happened?</Text>
              <Text style={styles.help}>Required — the server rejects a Lost move with blank notes.</Text>
              <TextInput
                testID="lost-notes"
                value={lostNotes}
                onChangeText={setLostNotes}
                placeholder="Undercut on price, went with an incumbent…"
                placeholderTextColor={theme.color.textMuted}
                multiline
                style={styles.input}
              />
            </>
          ) : null}

          {submitError ? (
            <Text testID="move-error" style={styles.error}>
              {submitError}
            </Text>
          ) : null}

          <Pressable
            testID="confirm-move"
            onPress={() => {
              setSubmitError(null);
              move.mutate();
            }}
            disabled={!canSubmit || move.isPending}
            accessibilityRole="button"
            accessibilityLabel="Confirm stage move"
            accessibilityState={{ disabled: !canSubmit || move.isPending, busy: move.isPending }}
            style={[styles.primary, (!canSubmit || move.isPending) && styles.primaryDisabled]}
          >
            {move.isPending ? (
              <ActivityIndicator color={theme.color.textInverse} />
            ) : (
              <Text style={styles.primaryText}>
                {target ? `Move to ${target.name}` : "Choose a stage"}
              </Text>
            )}
          </Pressable>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

function targetStage(
  stages: Array<{ id: string; name: string; slug: string }> | undefined,
  id: string | null,
) {
  if (!id) return null;
  return (stages ?? []).find((s) => s.id === id) ?? null;
}

/** What the gate is still waiting on, if anything. */
function MissingList({ verdict }: { verdict: pipelineApi.StagePreflight }) {
  const missing = verdict.missingRequirements;
  const items = [
    ...(missing?.fields ?? []).map((f) => ({ kind: "Field", label: f })),
    ...(missing?.documents ?? []).map((f) => ({ kind: "Document", label: f })),
    ...(missing?.approvals ?? []).map((f) => ({ kind: "Approval", label: f })),
  ];
  if (items.length === 0) return null;
  return (
    <View style={styles.missingWrap}>
      {items.map((i) => (
        <Text key={`${i.kind}:${i.label}`} style={styles.missingItem}>
          • {i.kind}: {i.label}
        </Text>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: theme.color.surfaceMuted },
  flex: { flex: 1 },
  body: { padding: theme.space.lg, gap: theme.space.sm, paddingBottom: theme.space.xxl },
  center: { flex: 1, alignItems: "center", justifyContent: "center", gap: theme.space.md },
  back: { fontFamily: theme.font.semibold, fontSize: 15, color: theme.color.brandRed },
  title: { fontFamily: theme.font.bold, fontSize: 26, color: theme.color.inkNavy },
  subtitle: { fontFamily: theme.font.semibold, fontSize: 15, color: theme.color.textSecondary },
  label: {
    marginTop: theme.space.lg,
    fontFamily: theme.font.semibold,
    fontSize: 12,
    letterSpacing: 1,
    textTransform: "uppercase",
    color: theme.color.textMuted,
  },
  help: { fontFamily: theme.font.regular, fontSize: 13, color: theme.color.textMuted },
  stageGrid: { flexDirection: "row", flexWrap: "wrap", gap: theme.space.sm, marginTop: theme.space.sm },
  stageOption: {
    borderRadius: theme.radius.pill,
    borderWidth: 1,
    borderColor: theme.color.border,
    backgroundColor: theme.color.surface,
    paddingHorizontal: theme.space.lg,
    paddingVertical: theme.space.sm,
  },
  stageOptionActive: { borderColor: theme.color.brandRed, backgroundColor: theme.color.redSurface },
  stageOptionDisabled: { opacity: 0.4 },
  stageOptionText: { fontFamily: theme.font.semibold, fontSize: 13, color: theme.color.textSecondary },
  stageOptionTextActive: { color: theme.color.brandRedDeep },
  checkingRow: { flexDirection: "row", alignItems: "center", gap: theme.space.sm, marginTop: theme.space.md },
  checkingText: { fontFamily: theme.font.regular, fontSize: 13, color: theme.color.textMuted },
  verdictBox: {
    marginTop: theme.space.md,
    backgroundColor: theme.color.surface,
    borderRadius: theme.radius.lg,
    borderWidth: 1,
    borderColor: theme.color.border,
    padding: theme.space.lg,
    gap: theme.space.xs,
  },
  blockBox: {
    marginTop: theme.space.md,
    backgroundColor: theme.color.amberSurface,
    borderRadius: theme.radius.md,
    padding: theme.space.lg,
    gap: theme.space.xs,
  },
  blockTitle: { fontFamily: theme.font.bold, fontSize: 15, color: theme.color.amberText },
  warnTitle: { fontFamily: theme.font.bold, fontSize: 15, color: theme.color.amberText },
  okTitle: { fontFamily: theme.font.bold, fontSize: 15, color: theme.color.green },
  blockBody: { fontFamily: theme.font.regular, fontSize: 14, color: theme.color.textSecondary },
  missingWrap: { marginTop: theme.space.sm, gap: 2 },
  missingItem: { fontFamily: theme.font.regular, fontSize: 13, color: theme.color.textSecondary },
  input: {
    marginTop: theme.space.sm,
    minHeight: 88,
    textAlignVertical: "top",
    borderWidth: 1,
    borderColor: theme.color.border,
    borderRadius: theme.radius.md,
    padding: theme.space.md,
    fontFamily: theme.font.regular,
    fontSize: 15,
    color: theme.color.textPrimary,
    backgroundColor: theme.color.surface,
  },
  error: { marginTop: theme.space.md, fontFamily: theme.font.regular, fontSize: 13, color: theme.color.brandRedDeep },
  primary: {
    marginTop: theme.space.xl,
    backgroundColor: theme.color.brandRed,
    borderRadius: theme.radius.md,
    paddingVertical: theme.space.md,
    alignItems: "center",
  },
  primaryDisabled: { opacity: 0.5 },
  primaryText: { fontFamily: theme.font.bold, fontSize: 15, color: theme.color.textInverse },
  secondary: {
    borderWidth: 1,
    borderColor: theme.color.border,
    borderRadius: theme.radius.md,
    paddingHorizontal: theme.space.lg,
    paddingVertical: theme.space.sm,
  },
  secondaryText: { fontFamily: theme.font.semibold, fontSize: 14, color: theme.color.textPrimary },
});
