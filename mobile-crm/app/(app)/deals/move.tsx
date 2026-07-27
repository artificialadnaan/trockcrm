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
import { qk } from "../../../src/query/keys";
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
 * Slugs that mean LOST, where the server additionally requires a reason id and non-blank notes.
 *
 * Mirrors LOST_DEAL_STAGE_SLUGS in shared/src/types/workflow.ts:313-315, which is the union of the
 * CANONICAL slug and its four legacy aliases. This app cannot import shared (it is deliberately not an
 * npm workspace), so it is a mirror — and the first version of it had all four ALIASES and omitted the
 * canonical "lost", which is the slug a current pipeline config actually uses. The effect was the worst
 * kind: the screen would not ask for a reason or notes, and the server would reject the move with a
 * message about fields the rep was never shown.
 */
const LOST_SLUGS = new Set([
  // canonical (workflow.ts:149)
  "lost",
  // legacy aliases (workflow.ts:297-302)
  "deal_canceled",
  "production_lost",
  "service_lost",
  "closed_lost",
]);

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
  });

  const lostReasons = useQuery({
    queryKey: ["lost-reasons"],
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

  const verdict = preflight.data;
  const needsOverride = Boolean(verdict?.requiresOverride);
  const blocked = Boolean(verdict && !verdict.allowed);

  const canSubmit =
    isOwner &&
    Boolean(targetStageId) &&
    !blocked &&
    (!needsOverride || overrideReason.trim().length > 0) &&
    (!isLostMove || (Boolean(lostReasonId) && lostNotes.trim().length > 0)) &&
    !preflight.isFetching;

  const move = useMutation({
    mutationFn: () =>
      pipelineApi.moveStage(fetcher, dealId, {
        targetStageId: targetStageId as string,
        overrideReason: needsOverride ? overrideReason.trim() : undefined,
        lostReasonId: isLostMove ? (lostReasonId as string) : undefined,
        lostNotes: isLostMove ? lostNotes.trim() : undefined,
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: qk.deal(scope, dealId) });
      await queryClient.invalidateQueries({ queryKey: ["deals", scope] });
      await queryClient.invalidateQueries({ queryKey: ["pipeline", scope] });
      router.back();
    },
    onError: (err) => {
      setSubmitError(
        err instanceof ApiError && err.status === 0
          ? "Couldn't reach the server. Nothing was changed."
          : err instanceof ApiError
            ? err.message
            : "Couldn't move the deal.",
      );
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

          {!isOwner ? (
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
          <View style={styles.stageGrid}>
            {stages
              .filter((s) => s.id !== deal.stageId)
              .map((s) => (
                <Pressable
                  key={s.id}
                  testID={`move-target-${s.slug}`}
                  onPress={() => {
                    setTargetStageId(s.id);
                    setSubmitError(null);
                  }}
                  disabled={!isOwner}
                  accessibilityRole="button"
                  accessibilityState={{ selected: targetStageId === s.id, disabled: !isOwner }}
                  style={[
                    styles.stageOption,
                    targetStageId === s.id && styles.stageOptionActive,
                    !isOwner && styles.stageOptionDisabled,
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

          {preflight.isFetching ? (
            <View style={styles.checkingRow}>
              <ActivityIndicator color={theme.color.brandRed} />
              <Text style={styles.checkingText}>Checking requirements…</Text>
            </View>
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

          {isOwner && needsOverride ? (
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
