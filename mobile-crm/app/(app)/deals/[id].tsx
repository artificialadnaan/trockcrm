import React, { useMemo, useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useGoBack } from "../../../src/lib/go-back";
import { SafeAreaView } from "react-native-safe-area-context";
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ApiError } from "../../../src/api/client";
import * as dealsApi from "../../../src/api/endpoints/deals";
import * as pipelineApi from "../../../src/api/endpoints/pipeline";
import { useAuth } from "../../../src/auth/AuthContext";
import { useQueryScope } from "../../../src/auth/useOfficeId";
import { displayAmount, showsAtRisk } from "../../../src/components/DealCard";
import { Badge } from "../../../src/components/Badge";
import { RetryNotice } from "../../../src/components/RetryNotice";
import { Row } from "../../../src/components/Row";
import { resolveListState } from "../../../src/list-state";
import { mailtoUrl, telUrl } from "../../../src/contact-links";
import { buildStageIndex, stageLabelFor } from "../../../src/stage-label";
import { openLink } from "../../../src/lib/open-link";
import { daysSince, formatDate, formatLocation } from "../../../src/format";
import { qk } from "../../../src/query/keys";
import { theme } from "../../../src/theme/theme";

export default function DealDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const dealId = typeof id === "string" ? id : "";
  const router = useRouter();
  // Back needs a destination: this screen is reachable by deep link and by restored
  // navigation state, where goBack() is a no-op and the control would do nothing.
  const goBack = useGoBack("/(app)/deals");
  // `session` is this branch's addition — the change-order lock and the ownership gate both need it.
  const { fetcher, session } = useAuth();
  const scope = useQueryScope();
  const queryClient = useQueryClient();
  const [note, setNote] = useState("");
  // A dialer or mail composer that refuses to open must SAY so — see openLink.
  const [linkError, setLinkError] = useState<string | null>(null);

  const dealQuery = useQuery({
    queryKey: qk.deal(scope, dealId),
    queryFn: () => dealsApi.getDealDetail(fetcher, dealId),
    enabled: dealId.length > 0,
  });

  const activitiesQuery = useInfiniteQuery({
    queryKey: qk.dealActivities(scope, dealId),
    initialPageParam: 1,
    // The server pages this at 50 (activities/service.ts:129). Without a load-more, a deal's history
    // simply stopped at the 50th entry while the timeline looked complete.
    queryFn: ({ pageParam }) => dealsApi.listActivities(fetcher, dealId, { page: pageParam }),
    getNextPageParam: (last) => {
      const p = last.pagination;
      if (!p) return undefined;
      return p.page < p.totalPages ? p.page + 1 : undefined;
    },
    enabled: dealId.length > 0,
  });

  // The stage NAMES. The detail row rendered the raw slug, so common stages read as
  // "estimate_sent_to_client" or "service_estimating" — internal identifiers shown to a rep, while the
  // list beside it already displayed the proper names. Same 30-minute staleTime as the list: stage
  // config is effectively static per office.
  const stagesQuery = useQuery({
    queryKey: qk.stages(scope),
    queryFn: () => dealsApi.listStages(fetcher),
    staleTime: 30 * 60_000,
  });

  // The SAME state machine the lists use — see resolveListState for the four ways this branching has
  // been got wrong. It was hand-rolled here, which is exactly the duplication that module exists to end.
  const activityState = resolveListState({
    isLoading: activitiesQuery.isLoading,
    data: activitiesQuery.data,
    error: activitiesQuery.error,
    isFetchNextPageError: activitiesQuery.isFetchNextPageError,
  });

  const activities = useMemo(
    () => (activitiesQuery.data?.pages ?? []).flatMap((p) => p.activities),
    [activitiesQuery.data],
  );

  const logNote = useMutation({
    mutationFn: (notes: string) =>
      dealsApi.createActivity(fetcher, { dealId, type: "note", body: notes }),
    onSuccess: async (_result, submitted) => {
      // Clear ONLY what was actually sent. A rep can keep typing while a slow save is in flight, and
      // blanking the field unconditionally would silently delete everything written after the request
      // began — losing exactly the observation they opened the app to record.
      //
      // Compared TRIMMED on both sides: the mutation is given note.trim(), so a note typed with a
      // trailing space never matched the raw field and stayed put after a successful save — inviting the
      // rep to submit the same note twice.
      setNote((current) => (current.trim() === submitted ? "" : current));
      await queryClient.invalidateQueries({ queryKey: qk.dealActivities(scope, dealId) });
    },
  });

  const watch = useMutation({
    mutationFn: (next: boolean) =>
      next ? dealsApi.watchDeal(fetcher, dealId) : dealsApi.unwatchDeal(fetcher, dealId),
    onSuccess: async () => {
      // CONCURRENT. invalidateQueries resolves only once the active queries have refetched, and
      // watch.isPending stays true for the whole handler — so awaiting four in series left the star
      // disabled for four sequential round trips after the toggle had already succeeded. The move screen
      // was made concurrent one commit ago and this was left serial in the same breath, having just
      // gained two more entries.
      //
      // All four are derived from the watch flag: the deal itself, the Watched list, and — via their
      // Mine/Watched scopes — the board and the stage drill-down. Those two are separate cache prefixes
      // that stay mounted underneath this screen, and refetchOnWindowFocus is off, so without them an
      // unwatched deal sits visibly on the Watched board until a manual pull.
      //
      // SCOPED, not a bare ["deals"]: that prefix-matches every user/office/role variant in the cache,
      // so one toggle would refetch lists this action cannot have changed.
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: qk.deal(scope, dealId) }),
        queryClient.invalidateQueries({ queryKey: ["deals", scope] }),
        queryClient.invalidateQueries({ queryKey: ["pipeline", scope] }),
        queryClient.invalidateQueries({ queryKey: ["stage-deals", scope] }),
      ]);
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

  // `!dealQuery.data`, NOT `dealQuery.error || !dealQuery.data`. TanStack keeps the previous data when a
  // later refetch fails — including the one this screen fires itself after a watch toggle — so keying the
  // blocking state on `error` replaced a fully usable deal with "Couldn't load this deal" and a Go back
  // button. The stale-data case is signalled inline instead; see refreshFailed below.
  if (!dealQuery.data) {
    const offline = dealQuery.error instanceof ApiError && dealQuery.error.status === 0;
    return (
      <SafeAreaView style={styles.safe}>
        <View style={styles.center}>
          <Text style={styles.errorTitle}>
            {!dealId ? "Deal not found" : offline ? "You're offline" : "Couldn't load this deal"}
          </Text>
          {/* With no usable id there is no query to retry — the button would sit there doing nothing,
              which is worse than not offering it. `enabled: false` means refetch() is a no-op. */}
          {dealId ? (
            <Pressable
              testID="deal-retry"
              onPress={() => void dealQuery.refetch()}
              accessibilityRole="button"
              style={styles.backBtn}
            >
              <Text style={styles.backBtnText}>Try again</Text>
            </Pressable>
          ) : null}
          <Pressable onPress={() => goBack()} accessibilityRole="button" style={styles.backBtn}>
            <Text style={styles.backBtnText}>Go back</Text>
          </Pressable>
        </View>
      </SafeAreaView>
    );
  }

  const deal = dealQuery.data;
  // The SERVER's effective stage age, which excludes paused (on-hold) time and uses the right stage-entry
  // timestamp for Bid Board-owned deals. Computing it from stageEnteredAt keeps counting paused days and
  // would show a materially different age than the web app for the same deal.
  const stageDays = deal.atRisk?.effectiveStageAgeDays ?? daysSince(deal.stageEnteredAt);
  const location = formatLocation(deal.propertyCity, deal.propertyState);
  // Data is on screen but the last refresh failed — say so without taking the screen away.
  const refreshFailed = Boolean(dealQuery.error);
  // MOBILE FIRST, matching contactPhone() on the contact surfaces. This read `phone ?? mobile`, so the
  // same person could be called on a different number depending on which screen you started from — and
  // the deal detail would pick the landline while the contact screen picked the mobile. The reason the
  // contacts helper prefers mobile is the reason it should win here too: it is the one that reaches
  // someone standing on a roof.
  const contactPhone = deal.primaryContactMobile ?? deal.primaryContactPhone;
  // Shared with the list, so the two can never disagree about which stage a deal is in.
  const stageLabel = stageLabelFor(deal, buildStageIndex(stagesQuery.data)) ?? "—";

  return (
    <SafeAreaView style={styles.safe} edges={["top"]}>
      {/* Without "handled", the first tap on Save only dismisses the keyboard and never reaches the
          button — so the rep's opening tap on the app's primary action silently does nothing. */}
      <ScrollView contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled">
        <Pressable onPress={() => goBack()} accessibilityRole="button" accessibilityLabel="Back">
          <Text style={styles.back}>‹ Deals</Text>
        </Pressable>

        {refreshFailed ? (
          <Pressable
            testID="deal-refresh-retry"
            onPress={() => void dealQuery.refetch()}
            accessibilityRole="button"
            style={styles.staleBanner}
          >
            <Text style={styles.staleText}>Showing saved data — couldn&apos;t refresh. Tap to retry.</Text>
          </Pressable>
        ) : null}

        <Text style={styles.name}>{deal.name ?? "Untitled deal"}</Text>
        {deal.companyName ? <Text style={styles.company}>{deal.companyName}</Text> : null}

        <View style={styles.badgeRow}>
          <Text style={styles.amount}>{displayAmount(deal)}</Text>
          {/* Effective, not stored: a far-future close target parks a deal whose onHold is false. */}
          {(deal.effectiveOnHold ?? deal.onHold) ? <Badge label="On hold" tone="amber" /> : null}
          {showsAtRisk(deal) ? <Badge label="At risk" tone="red" /> : null}
        </View>

        <Pressable
          testID="watch-toggle"
          onPress={() => watch.mutate(!deal.isWatching)}
          disabled={watch.isPending}
          accessibilityRole="button"
          accessibilityState={{ selected: deal.isWatching }}
          style={styles.watchBtn}
        >
          <Text style={styles.watchText}>{deal.isWatching ? "★ Watching" : "☆ Watch"}</Text>
        </Pressable>
        {/* A silent failure here is indistinguishable from success: the button re-enables with its old
            label, so the rep believes they are watching a deal they are not, and stops checking it. */}
        {watch.error ? (
          <Text testID="watch-error" style={styles.watchError}>
            {watch.error instanceof ApiError && watch.error.status === 0
              ? "Couldn't update — you appear to be offline."
              : watch.error instanceof ApiError
                ? watch.error.message
                : "Couldn't update your watch setting."}
          </Text>
        ) : null}

        {/* Offered only to the assigned rep: the commit route is owner-only with no admin or director
            bypass, so showing this to anyone else is an invitation to a 403.
            AND not at all for a deal the route locks outright — a change order is rejected with a 409
            no matter who asks, while preflight would still report it as ready. */}
        {!pipelineApi.stageMoveLock(deal).locked &&
        deal.assignedRepId &&
        deal.assignedRepId === session?.user.id ? (
          <Pressable
            testID="open-move-stage"
            onPress={() => router.push({ pathname: "/(app)/deals/move", params: { dealId } })}
            accessibilityRole="button"
            accessibilityLabel="Move this deal to another stage"
            style={styles.moveBtn}
          >
            <Text style={styles.moveText}>Move stage</Text>
          </Pressable>
        ) : null}

        <Section title="Details">
          {/* displayStageSlug is bid-board-aware: an owned deal can advance or close in Bid Board
              while its CRM stageSlug still reads an earlier stage. The web detail switches the same way.
              Falls back to the raw slug rather than a dash — a Bid Board stage has no CRM pipeline row
              to name it, and the slug is still more use to a rep than nothing. */}
          <Row label="Stage" value={stageLabel} />
          <Row label="Days in stage" value={stageDays === null ? "—" : String(stageDays)} />
          <Row label="Close date" value={formatDate(deal.expectedCloseDate)} />
          {location ? <Row label="Location" value={location} /> : null}
          {deal.assignedRepName ? <Row label="Rep" value={deal.assignedRepName} /> : null}
          {deal.projectType ? <Row label="Type" value={deal.projectType} /> : null}
        </Section>

        {deal.primaryContactName ? (
          <Section title="Primary contact">
            <Row label="Name" value={deal.primaryContactName} />
            {/* Tap-to-call and tap-to-email are the whole point of a contact on a phone. */}
            {contactPhone ? (
              <ContactAction
                testID="call-contact"
                label="Call"
                value={contactPhone}
                url={telUrl(contactPhone)}
                onFailure={setLinkError}
              />
            ) : null}
            {deal.primaryContactEmail ? (
              <ContactAction
                testID="email-contact"
                label="Email"
                value={deal.primaryContactEmail}
                url={mailtoUrl(deal.primaryContactEmail)}
                onFailure={setLinkError}
              />
            ) : null}
            {linkError ? (
              <Text testID="contact-link-error" style={styles.linkError}>
                {linkError}
              </Text>
            ) : null}
          </Section>
        ) : null}

        <Section title="Log a note">
          <TextInput
            testID="note-input"
            value={note}
            onChangeText={setNote}
            placeholder="What just happened?"
            placeholderTextColor={theme.color.textMuted}
            multiline
            style={styles.noteInput}
          />
          {logNote.error ? (
            <Text style={styles.noteError}>
              {logNote.error instanceof ApiError && logNote.error.status === 0
                ? "Couldn't save — you appear to be offline."
                : "Couldn't save that note."}
            </Text>
          ) : null}
          <Pressable
            testID="save-note"
            onPress={() => logNote.mutate(note.trim())}
            disabled={note.trim().length === 0 || logNote.isPending}
            accessibilityRole="button"
            accessibilityLabel="Save note"
            style={[
              styles.saveNote,
              (note.trim().length === 0 || logNote.isPending) && styles.saveNoteDisabled,
            ]}
          >
            {logNote.isPending ? (
              <ActivityIndicator color={theme.color.textInverse} />
            ) : (
              <Text style={styles.saveNoteText}>Save note</Text>
            )}
          </Pressable>
        </Section>

        <Section title="Activity">
          {/* A failed background REFRESH belongs at the top of the section, beside the heading — not
              under the timeline. The two failures are read in different places: a refresh fails while
              the user is looking at the newest entries at the top, so a notice below fifty rows is
              off-screen and the stale data reads as freshly loaded. A failed LOAD-MORE is the opposite
              — the user is at the bottom, which is where that one stays. Same reasoning RetryNotice's
              `placement` encodes; both were bottom, so only one of them was right. */}
          {activityState.kind === "loaded" && activityState.refreshFailed ? (
            <RetryNotice
              testID="retry-activities-inline"
              message="Couldn't refresh activity — tap to retry"
              onRetry={() => void activitiesQuery.refetch()}
              placement="top"
            />
          ) : null}

          {activityState.kind === "loading" ? (
            <ActivityIndicator color={theme.color.brandRed} />
          ) : activityState.kind === "blocking-error" ? (
            // A failed timeline request is NOT an empty timeline. Claiming "nothing logged" on a 5xx
            // presents a failure as authoritative CRM data, and a rep would believe it.
            //
            // Gated on `data === undefined`, not on row count. A deal with genuinely NO activity has
            // loaded successfully, so a later failed refetch must stay inline like any other background
            // failure — keying on length treated "loaded, and empty" as "never loaded" and replaced the
            // real empty state with a retry prompt. Same distinction as the lists.
            <Pressable
              testID="retry-activities"
              onPress={() => void activitiesQuery.refetch()}
              accessibilityRole="button"
              style={styles.retry}
            >
              <Text style={styles.retryText}>Couldn&apos;t load activity — tap to retry</Text>
            </Pressable>
          ) : activities.length === 0 ? (
            <Text style={styles.emptyActivity}>Nothing logged yet.</Text>
          ) : (
            activities.map((a) => (
              <View key={a.id} style={styles.activity}>
                <Text style={styles.activityMeta}>
                  {a.type}
                  {a.performedByUserName ? ` · ${a.performedByUserName}` : ""}
                  {a.occurredAt ?? a.createdAt ? ` · ${formatDate(a.occurredAt ?? a.createdAt)}` : ""}
                </Text>
                {a.subject ? <Text style={styles.activitySubject}>{a.subject}</Text> : null}
                {/* The note text lives in `body`. Reading `notes` rendered every entry blank. */}
                {a.body ? <Text style={styles.activityNotes}>{a.body}</Text> : null}
              </View>
            ))
          )}

          {/* Older history is reachable rather than silently truncated at the server's 50-row page.
              HIDDEN once a page fetch has failed: hasNextPage stays true after a failure, so this sat
              directly above the RetryNotice offering the same action in different words — two controls,
              one of them not acknowledging that anything went wrong. The notice is the retry while a
              failure is outstanding; this returns as soon as one succeeds. */}
          {activities.length > 0 && activitiesQuery.hasNextPage &&
          !(activityState.kind === "loaded" && activityState.pageFailed) ? (
            <Pressable
              testID="load-more-activities"
              onPress={() => {
                if (!activitiesQuery.isFetchingNextPage) void activitiesQuery.fetchNextPage();
              }}
              disabled={activitiesQuery.isFetchingNextPage}
              accessibilityRole="button"
              style={styles.retry}
            >
              {activitiesQuery.isFetchingNextPage ? (
                <ActivityIndicator color={theme.color.brandRed} />
              ) : (
                <Text style={styles.retryText}>Load older activity</Text>
              )}
            </Pressable>
          ) : null}

          {/* A failed load-more, at the bottom where the user asked for it. Gated on `data !== undefined`
              rather than on row count — the blocking branch above already keys on that, and requiring
              rows here meant a deal with NO activity reported its failed refresh nowhere at all: no
              notice, no retry, just the unchanged "Nothing logged yet". Silently wrong in exactly the
              state the empty message claims to be authoritative about. */}
          {activityState.kind === "loaded" && activityState.pageFailed ? (
            <RetryNotice
              testID="retry-activities-page"
              message="Couldn't load older activity — tap to retry"
              onRetry={() => void activitiesQuery.fetchNextPage()}
              placement="bottom"
            />
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

function ContactAction({
  testID,
  label,
  value,
  url,
  onFailure,
}: {
  testID: string;
  label: string;
  value: string;
  url: string;
  // Nullable: openLink reports null on success, which clears a previous failure.
  onFailure: (message: string | null) => void;
}) {
  return (
    <Pressable
      testID={testID}
      onPress={() => void openLink(url, onFailure)}
      accessibilityRole="button"
      accessibilityLabel={`${label} ${value}`}
      style={styles.contactRow}
    >
      <Text style={styles.contactLabel}>{label}</Text>
      <Text style={[styles.rowValue, styles.link]}>{value}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: theme.color.canvas },
  body: { padding: theme.space.lg, gap: theme.space.sm, paddingBottom: theme.space.xxl },
  center: { flex: 1, alignItems: "center", justifyContent: "center", gap: theme.space.md },
  back: { fontFamily: theme.font.semibold, fontSize: 15, color: theme.color.redText },
  name: { fontFamily: theme.font.bold, fontSize: 24, color: theme.color.inkNavy, marginTop: theme.space.sm },
  company: { fontFamily: theme.font.semibold, fontSize: 15, color: theme.color.textSecondary },
  badgeRow: { flexDirection: "row", alignItems: "center", gap: theme.space.sm, marginTop: theme.space.xs },
  amount: { fontFamily: theme.font.bold, fontSize: 20, color: theme.color.textPrimary },
  badgeText: { fontFamily: theme.font.semibold, fontSize: 12 },
  badgeTextAmber: { color: theme.color.amberText },
  badgeTextRed: { color: theme.color.redText },
  moveBtn: {
    marginTop: theme.space.sm,
    borderWidth: 1,
    borderColor: theme.color.brandRed,
    borderRadius: theme.radius.md,
    paddingVertical: theme.space.md,
    alignItems: "center",
  },
  moveText: { fontFamily: theme.font.bold, fontSize: 15, color: theme.color.redText },
  watchBtn: {
    alignSelf: "flex-start",
    borderWidth: 1,
    borderColor: theme.color.border,
    borderRadius: theme.radius.pill,
    paddingHorizontal: theme.space.lg,
    paddingVertical: theme.space.sm,
    backgroundColor: theme.color.surface,
    marginTop: theme.space.sm,
  },
  watchText: { fontFamily: theme.font.semibold, fontSize: 13, color: theme.color.textPrimary },
  section: { marginTop: theme.space.lg, gap: theme.space.sm },
  sectionTitle: {
    fontFamily: theme.font.semibold,
    fontSize: 12,
    letterSpacing: 1,
    color: theme.color.textMuted,
    textTransform: "uppercase",
  },
  sectionBody: {
    backgroundColor: theme.color.surface,
    borderRadius: theme.radius.lg,
    borderWidth: 1,
    borderColor: theme.color.border,
    padding: theme.space.lg,
    gap: theme.space.sm,
  },
  contactRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    gap: theme.space.md,
  },
  contactLabel: { fontFamily: theme.font.regular, fontSize: 14, color: theme.color.textSecondary },
  linkError: { fontFamily: theme.font.regular, fontSize: 13, color: theme.color.redText },
  rowValue: { flexShrink: 1, textAlign: "right", fontFamily: theme.font.semibold, fontSize: 14, color: theme.color.textPrimary },
  link: { color: theme.color.redText },
  noteInput: {
    borderWidth: 1,
    borderColor: theme.color.borderControl,
    borderRadius: theme.radius.md,
    padding: theme.space.md,
    minHeight: 88,
    textAlignVertical: "top",
    fontFamily: theme.font.regular,
    fontSize: 15,
    color: theme.color.textPrimary,
  },
  noteError: { fontFamily: theme.font.regular, fontSize: 13, color: theme.color.redText },
  watchError: {
    marginTop: theme.space.xs,
    fontFamily: theme.font.regular,
    fontSize: 13,
    color: theme.color.redText,
  },
  staleBanner: {
    marginTop: theme.space.sm,
    borderRadius: theme.radius.md,
    backgroundColor: theme.color.amberSurface,
    paddingHorizontal: theme.space.md,
    paddingVertical: theme.space.sm,
  },
  staleText: { fontFamily: theme.font.semibold, fontSize: 13, color: theme.color.amberText },
  saveNote: {
    backgroundColor: theme.color.brandRed,
    borderRadius: theme.radius.md,
    paddingVertical: theme.space.md,
    alignItems: "center",
  },
  saveNoteDisabled: { opacity: 0.5 },
  saveNoteText: { fontFamily: theme.font.bold, fontSize: 15, color: theme.color.textInverse },
  retry: {
    borderWidth: 1,
    borderColor: theme.color.border,
    borderRadius: theme.radius.md,
    paddingVertical: theme.space.md,
    alignItems: "center",
  },
  retryText: { fontFamily: theme.font.semibold, fontSize: 14, color: theme.color.redText },
  emptyActivity: { fontFamily: theme.font.regular, fontSize: 14, color: theme.color.textMuted },
  activity: { gap: 2, paddingVertical: theme.space.sm },
  // textSecondary, not textMuted: #8A95A3 on white is ~3:1, under the 4.5:1 floor for normal
  // text, and at 12px on a phone outdoors it is the first thing to become unreadable.
  activityMeta: { fontFamily: theme.font.regular, fontSize: 12, color: theme.color.textSecondary },
  activitySubject: { fontFamily: theme.font.semibold, fontSize: 14, color: theme.color.textPrimary },
  activityNotes: { fontFamily: theme.font.regular, fontSize: 14, color: theme.color.textSecondary },
  errorTitle: { fontFamily: theme.font.bold, fontSize: 17, color: theme.color.inkNavy },
  backBtn: {
    borderWidth: 1,
    borderColor: theme.color.border,
    borderRadius: theme.radius.md,
    paddingHorizontal: theme.space.lg,
    paddingVertical: theme.space.sm,
  },
  backBtnText: { fontFamily: theme.font.semibold, fontSize: 14, color: theme.color.textPrimary },
});
