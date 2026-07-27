import React, { useMemo, useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useGoBack } from "../../../src/lib/go-back";
import { SafeAreaView } from "react-native-safe-area-context";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ApiError } from "../../../src/api/client";
import * as leadsApi from "../../../src/api/endpoints/leads";
import { useAuth } from "../../../src/auth/AuthContext";
import { useQueryScope } from "../../../src/auth/useOfficeId";
import { Badge } from "../../../src/components/Badge";
import { Row } from "../../../src/components/Row";
import { formatDate, formatLocation } from "../../../src/format";
import { qk } from "../../../src/query/keys";
import { theme } from "../../../src/theme/theme";

export default function LeadDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const leadId = typeof id === "string" ? id : "";
  const router = useRouter();
  // Back needs a destination: this screen is reachable by deep link and by restored navigation state,
  // where goBack() is a no-op and the control would render, be tappable, and do nothing.
  const goBack = useGoBack("/(app)/leads");
  const { fetcher, session } = useAuth();
  const scope = useQueryScope();
  const queryClient = useQueryClient();

  /** The last refusal, kept so the rep can see WHAT the lead still needs rather than just that it failed. */
  const [refusal, setRefusal] = useState<leadsApi.LeadTransitionRefusal | null>(null);
  const [transitionError, setTransitionError] = useState<string | null>(null);

  const leadQuery = useQuery({
    queryKey: qk.lead(scope, leadId),
    queryFn: () => leadsApi.getLead(fetcher, leadId),
    enabled: leadId.length > 0,
  });

  const stagesQuery = useQuery({
    queryKey: qk.leadStages(scope),
    queryFn: () => leadsApi.listLeadStages(fetcher),
    staleTime: 30 * 60_000,
  });

  const lead = leadQuery.data;
  const stages = useMemo(
    () => (stagesQuery.data ?? []).filter((s) => s.isActivePipeline !== false),
    [stagesQuery.data],
  );

  const transition = useMutation({
    mutationFn: (targetStageId: string) =>
      leadsApi.transitionLeadStage(fetcher, leadId, { targetStageId }),
    onSuccess: async (result) => {
      // A REFUSAL arrives here as a successful promise carrying ok:false — the endpoint answers 409 with
      // the reason. Treating that as a win would move the UI on from a transition that never happened.
      if (!result.ok) {
        setRefusal(result);
        return;
      }
      setRefusal(null);
      /**
       * AWAITED, unlike the deals move screen — because this screen STAYS.
       *
       * There the handler navigates away immediately, so firing invalidations without waiting is right:
       * nothing is left on screen to act on. Here the rep is still looking at the lead, and
       * `isPending` goes false the moment this handler returns. Discarding the promise re-enabled every
       * stage button while `lead.stageId` was still the OLD one, so a second tap on a slow refetch
       * resubmits the SAME target — and the server accepts a same-stage update and unconditionally
       * rewrites stage_entered_at, silently resetting the stage age every SLA and at-risk calculation
       * is measured from. The same "make it concurrent" instinct is correct in one screen and
       * corrupting in the other; what differs is whether anything is still on screen to press.
       */
      /**
       * COMMIT the server's own updated lead first, then invalidate.
       *
       * `invalidateQueries` swallows refetch errors by default, so awaiting it resolves even when the
       * refetch FAILED — leaving the cache on the old stageId while `isPending` goes false. The screen
       * then re-enables the same move and a second tap resubmits an already-completed transition, which
       * the server accepts and which rewrites stage_entered_at, resetting the stage age every SLA reads.
       * Awaiting was necessary and not sufficient; the response already contains the new lead, so the
       * cache is written from it rather than hoping a network round-trip succeeds.
       */
      queryClient.setQueryData(qk.lead(scope, leadId), result.lead);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: qk.lead(scope, leadId) }),
        queryClient.invalidateQueries({ queryKey: ["leads", scope] }),
      ]);
    },
    onError: async (err) => {
      setRefusal(null);
      if (!(err instanceof ApiError)) {
        setTransitionError("Couldn't move the lead.");
        return;
      }

      /**
       * ONE rule, not a branch per status code.
       *
       * Every failure here falls into one of two kinds, and the distinction that matters is not which
       * code arrived but whether the screen's copy of the lead can still be trusted:
       *
       *   0 / 408 — INDETERMINATE. The connection dropped, or our own 30s timeout fired while the
       *             server may already have committed. Retrying blind resubmits the same target, and a
       *             same-stage update rewrites stage_entered_at, resetting the stage age every SLA reads.
       *   403     — the lead was REASSIGNED after this screen loaded. The cached assignedRepId still
       *             makes isOwner true, so the control stays live and every retry repeats the 403.
       *   409     — the lead went terminal, or the move skips a canonical stage. Same shape: the cached
       *             lead looks workable and is not.
       *
       * All four leave a stale screen offering an action that cannot succeed, so all four refresh. This
       * arrived as three separate reports because it was written as three separate branches and I added
       * them one at a time; as a single predicate the next status in this family is covered already.
       */
      const staleAfterFailure =
        err.status === 0 || err.status === 403 || err.status === 408 || err.status === 409;

      setTransitionError(
        err.status === 0 || err.status === 408
          ? "The move may or may not have gone through — refreshing. Check the stage before trying again."
          : err.message,
      );

      if (staleAfterFailure) {
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: qk.lead(scope, leadId) }),
          queryClient.invalidateQueries({ queryKey: ["leads", scope] }),
        ]);
      }
    },
  });

  if (leadQuery.isLoading) {
    return (
      <SafeAreaView style={styles.safe}>
        <View style={styles.center}>
          <ActivityIndicator color={theme.color.brandRed} />
        </View>
      </SafeAreaView>
    );
  }

  // `!data`, not `error` — TanStack keeps the previous data when a later refetch fails, so keying the
  // blocking state on error replaces a perfectly usable lead with an error screen.
  if (!lead) {
    const offline = leadQuery.error instanceof ApiError && leadQuery.error.status === 0;
    return (
      <SafeAreaView style={styles.safe}>
        <View style={styles.center}>
          <Text style={styles.errorTitle}>
            {!leadId ? "Lead not found" : offline ? "You're offline" : "Couldn't load this lead"}
          </Text>
          {leadId ? (
            <Pressable
              testID="lead-retry"
              onPress={() => void leadQuery.refetch()}
              accessibilityRole="button"
              style={styles.retryBtn}
            >
              <Text style={styles.retryText}>Try again</Text>
            </Pressable>
          ) : null}
          <Pressable onPress={() => goBack()} accessibilityRole="button" style={styles.retryBtn}>
            <Text style={styles.retryText}>Go back</Text>
          </Pressable>
        </View>
      </SafeAreaView>
    );
  }

  const open = leadsApi.isLeadOpen(lead);
  const location = formatLocation(lead.property?.city, lead.property?.state);
  const refreshFailed = Boolean(leadQuery.error);

  /**
   * OWNERSHIP, exactly as on the deals move screen.
   *
   * The transition route calls assertLeadOwnerAccess with NO admin or director override
   * (leads/routes.ts:525-527), so a director or admin looking at someone else's lead — reachable
   * through the All scope, and through Mine's created/subscribed visibility — gets a hard 403. Showing
   * them the stage buttons is an invitation to that failure; saying so up front is the whole reason
   * this pattern exists.
   */
  const isOwner = Boolean(session?.user.id && lead.assignedRepId === session.user.id);

  /**
   * The stage NAME, resolved here rather than read off the row.
   *
   * getLeadById decorates through decorateLeads WITHOUT the stage-name map that listLeads passes
   * (service.ts:1388 vs :1517), so `stageName` is null on every detail response — the header silently
   * omitted the current stage while the stages query sat right there holding it.
   */
  const stageName =
    lead.stageName ??
    (lead.stageId ? (stagesQuery.data ?? []).find((s) => s.id === lead.stageId)?.name : undefined);

  /**
   * The date, from fields this endpoint actually returns.
   *
   * `displayDate` is computed in the LIST query's SELECT; the detail selects the raw row and has no such
   * column, so reading it rendered "—" on every detail screen. Outcome-aware, matching the axis the list
   * displays and the server filters on: the date a lead ENDED if it ended, otherwise when it entered its
   * stage, otherwise when it was created.
   */
  // The ONE legal target. See nextLeadStage: a forward skip is a hard 409, so a grid of every other
  // stage was mostly guaranteed failures sitting beside the single move that works.
  const nextStage = leadsApi.nextLeadStage(stagesQuery.data ?? [], lead.stageId);

  const detailDate =
    lead.displayDate ?? lead.convertedAt ?? lead.disqualifiedAt ?? lead.stageEnteredAt ?? lead.createdAt;

  /**
   * The source, across all three columns.
   *
   * Under lead-edit-v2 the source is written to sourceCategory/sourceDetail and the legacy `source`
   * column is left null, so reading `source` alone showed "—" for every lead created since that flag
   * went on. Category first with its detail, then the legacy value.
   */
  const sourceLabel =
    [lead.sourceCategory, lead.sourceDetail].filter(Boolean).join(" · ") || lead.source || "—";

  return (
    <SafeAreaView style={styles.safe} edges={["top"]}>
      <ScrollView contentContainerStyle={styles.body}>
        <Pressable onPress={() => goBack()} accessibilityRole="button" hitSlop={8}>
          <Text style={styles.back}>‹ Leads</Text>
        </Pressable>

        <Text style={styles.title}>{lead.name ?? "Untitled lead"}</Text>
        <View style={styles.badges}>
          {stageName ? <Text style={styles.stage}>{stageName}</Text> : null}
          {lead.status === "converted" ? <Badge label="Converted" tone="green" /> : null}
          {lead.status === "disqualified" ? <Badge label="Disqualified" tone="amber" /> : null}
        </View>

        {refreshFailed ? (
          <Text style={styles.staleNote}>Couldn&apos;t refresh — showing the saved copy.</Text>
        ) : null}

        {/* A converted lead links to the deal it became. That link is the main reason a converted lead
            stays readable at all, so it is an ACTION rather than a line of text. */}
        {lead.convertedDealId ? (
          <Pressable
            testID="open-converted-deal"
            onPress={() => router.push(`/(app)/deals/${lead.convertedDealId}`)}
            accessibilityRole="button"
            accessibilityLabel="Open the deal this lead became"
            style={styles.linkBtn}
          >
            <Text style={styles.linkText}>
              Open deal {lead.convertedDealNumber ?? ""} ›
            </Text>
          </Pressable>
        ) : null}

        <Section title="Details">
          <Row label="Company" value={lead.companyName ?? "—"} />
          <Row label="Contact" value={lead.primaryContactName ?? "—"} />
          {/* projectType is an OBJECT on reads — printing it directly gives "[object Object]". */}
          <Row label="Project type" value={lead.projectType?.name ?? "—"} />
          <Row label="Property" value={lead.property?.name ?? lead.property?.address ?? "—"} />
          <Row label="Location" value={location || "—"} />
          <Row label="Assigned rep" value={lead.assignedRepName ?? "—"} />
          <Row label="Source" value={sourceLabel} />
          <Row label="Date" value={detailDate ? formatDate(detailDate) : "—"} />
        </Section>

        <Section title="Move stage">
          {/* TERMINAL first, ownership second. A converted lead assigned to someone else is refused for
              BOTH reasons, and leading with ownership said "only the assigned rep can change this" —
              which is false, since the server refuses them too. The more fundamental reason goes first
              because it is the one that does not depend on who is asking. */}
          {!open ? (
            /* Converted and disqualified leads keep a name, a stage and a rep, so nothing about the row
               says it cannot be worked. */
            <Text testID="lead-terminal" style={styles.help}>
              This lead is {lead.status}. Its stage can no longer be changed.
            </Text>
          ) : !isOwner ? (
            /* Said up front rather than after a 403. The route is strictly owner-only with no admin or
               director bypass, which surprises people who have one everywhere else. */
            <Text testID="lead-not-owner" style={styles.help}>
              {lead.assignedRepName
                ? `Only ${lead.assignedRepName}, the assigned rep, can change this lead's stage.`
                : "Only the assigned rep can change this lead's stage."}
            </Text>
          ) : stagesQuery.isLoading ? (
            <ActivityIndicator color={theme.color.brandRed} />
          ) : stagesQuery.isError && stagesQuery.data === undefined ? (
            <Pressable
              testID="lead-stages-retry"
              onPress={() => void stagesQuery.refetch()}
              accessibilityRole="button"
              style={styles.retryBtn}
            >
              <Text style={styles.retryText}>Couldn&apos;t load the stages — try again</Text>
            </Pressable>
          ) : stages.length === 0 ? (
            <Text style={styles.help}>No lead stages are configured for this office.</Text>
          ) : (
            !nextStage ? (
              /* Already at the end of the canonical pipeline — the remaining moves are conversion and
                 disqualification, which are different endpoints, not stage transitions. */
              <Text style={styles.help}>
                This lead is at the last stage. Converting or disqualifying it happens on the web.
              </Text>
            ) : (
              <View style={styles.stageGrid}>
                <Pressable
                  testID={`lead-target-${nextStage.slug}`}
                  onPress={() => {
                    setTransitionError(null);
                    transition.mutate(nextStage.id);
                  }}
                  disabled={transition.isPending}
                  accessibilityRole="button"
                  accessibilityLabel={`Move this lead to ${nextStage.name}`}
                  accessibilityState={{ disabled: transition.isPending, busy: transition.isPending }}
                  style={[styles.stageOption, transition.isPending && styles.stageOptionDisabled]}
                >
                  <Text style={styles.stageOptionText}>Move to {nextStage.name}</Text>
                </Pressable>
              </View>
            )
          )}

          {transition.isPending ? <ActivityIndicator color={theme.color.brandRed} /> : null}

          {/* The REFUSAL payload, which is the useful half of this endpoint: the server names each thing
              the lead still needs and says whether it can be fixed here or only on the full record. */}
          {refusal ? (
            <View testID="lead-transition-refusal" style={styles.refusalBox}>
              <Text style={styles.refusalTitle}>Can&apos;t move yet</Text>
              <Text style={styles.refusalItem}>
                {(refusal.missing ?? []).length > 0
                  ? "Set these on the full lead record, then try again:"
                  : ""}
              </Text>
              {(refusal.missing ?? []).length > 0 ? (
                (refusal.missing ?? []).map((item) => (
                  /* Both resolutions point at the full record, because THIS screen has no editor and
                     the transition adapter does not send the server's inlinePatch. Repeating the
                     server's "inline" hint would promise a remedy that does not exist here — the rep
                     would look for a field that is not on the screen. */
                  <Text key={item.key} style={styles.refusalItem}>
                    • {item.label}
                  </Text>
                ))
              ) : (
                /* A refusal with no itemised list still has to say something — this is also the shape
                   reconstructed when the 409 body could not be read. */
                <Text style={styles.refusalItem}>
                  This lead is missing information the stage requires. Open it on the web to finish it.
                </Text>
              )}
            </View>
          ) : null}

          {transitionError ? (
            <Text testID="lead-transition-error" style={styles.error}>
              {transitionError}
            </Text>
          ) : null}
        </Section>
      </ScrollView>
    </SafeAreaView>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>{title}</Text>
      <View style={styles.sectionBody}>{children}</View>
    </View>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: theme.color.surfaceMuted },
  body: { padding: theme.space.lg, gap: theme.space.md, paddingBottom: theme.space.xxl },
  back: { fontFamily: theme.font.semibold, fontSize: 15, color: theme.color.brandRed },
  title: { fontFamily: theme.font.bold, fontSize: 24, color: theme.color.inkNavy },
  badges: { flexDirection: "row", alignItems: "center", gap: theme.space.sm, flexWrap: "wrap" },
  stage: { fontFamily: theme.font.semibold, fontSize: 13, color: theme.color.textSecondary },
  staleNote: { fontFamily: theme.font.regular, fontSize: 12, color: theme.color.amberText },
  linkBtn: {
    minHeight: 44,
    justifyContent: "center",
    borderRadius: theme.radius.md,
    borderWidth: 1,
    borderColor: theme.color.brandRed,
    paddingHorizontal: theme.space.lg,
  },
  linkText: { fontFamily: theme.font.semibold, fontSize: 14, color: theme.color.brandRed },
  section: { gap: theme.space.sm },
  sectionTitle: { fontFamily: theme.font.bold, fontSize: 13, color: theme.color.textMuted, textTransform: "uppercase" },
  sectionBody: {
    backgroundColor: theme.color.surface,
    borderRadius: theme.radius.lg,
    borderWidth: 1,
    borderColor: theme.color.border,
    padding: theme.space.lg,
    gap: theme.space.sm,
  },
  help: { fontFamily: theme.font.regular, fontSize: 13, color: theme.color.textSecondary },
  stageGrid: { flexDirection: "row", flexWrap: "wrap", gap: theme.space.sm },
  stageOption: {
    minHeight: 44,
    justifyContent: "center",
    borderRadius: theme.radius.pill,
    borderWidth: 1,
    borderColor: theme.color.border,
    paddingHorizontal: theme.space.lg,
    backgroundColor: theme.color.surface,
  },
  stageOptionDisabled: { opacity: 0.5 },
  stageOptionText: { fontFamily: theme.font.semibold, fontSize: 13, color: theme.color.textPrimary },
  refusalBox: {
    borderRadius: theme.radius.md,
    backgroundColor: theme.color.amberSurface,
    padding: theme.space.md,
    gap: theme.space.xs,
  },
  refusalTitle: { fontFamily: theme.font.bold, fontSize: 14, color: theme.color.amberText },
  refusalItem: { fontFamily: theme.font.regular, fontSize: 13, color: theme.color.amberText },
  error: { fontFamily: theme.font.semibold, fontSize: 13, color: theme.color.brandRedDeep },
  center: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: theme.space.xl,
    gap: theme.space.sm,
  },
  errorTitle: { fontFamily: theme.font.bold, fontSize: 17, color: theme.color.inkNavy },
  retryBtn: {
    marginTop: theme.space.sm,
    minHeight: 44,
    justifyContent: "center",
    borderWidth: 1,
    borderColor: theme.color.brandRed,
    borderRadius: theme.radius.md,
    paddingHorizontal: theme.space.xl,
  },
  retryText: { fontFamily: theme.font.bold, fontSize: 14, color: theme.color.brandRed },
});
