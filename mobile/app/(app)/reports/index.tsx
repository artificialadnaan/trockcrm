import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useFocusEffect, useRouter } from "expo-router";
import { useQuery } from "@tanstack/react-query";
import { Ionicons } from "@expo/vector-icons";
import { theme } from "../../../src/theme/theme";
import { useAuth } from "../../../src/auth/AuthContext";
import { getWeeklyReport, getWeeklyReportAssignments } from "../../../src/api/endpoints";
import type {
  WeeklyReportAssignment,
  WeeklyReportReviewItem,
  WeeklyReportUndeliveredSend,
} from "../../../src/api/types";
import { newClientUploadId, uploadOwnerKey } from "../../../src/capture/upload-queue";
import { newSubmissionId } from "../../../src/scorecards/ids";
import {
  createWeeklyReportDraft,
  weeklyReportDraftSectionsFilled,
  weeklyReportDraftSignature,
  type WeeklyReportDraft,
} from "../../../src/weekly-reports/draft";
import {
  deleteWeeklyReportDraft,
  listWeeklyReportDrafts,
  saveWeeklyReportDraft,
} from "../../../src/weekly-reports/draft-store";
import { weeklyReportOpenTarget } from "../../../src/weekly-reports/hub";
import {
  WEEKLY_REPORT_DOOR_READ_TIMEOUT_MS,
  openWeeklyReportDoor,
  type WeeklyReportDoorChoice,
} from "../../../src/weekly-reports/door";
import { weeklyReportDiscardWarning } from "../../../src/weekly-reports/reconcile";
import {
  weeklyReportDeliveryLabel,
  weeklyReportDeliveryState,
  weeklyReportUndeliveredSummary,
} from "../../../src/weekly-reports/delivery";
import {
  formatWeekOf,
  weeklyReportDueLabel,
  weeklyReportProjectAction,
  weeklyReportQueueTruncationNote,
  weeklyReportUndeliveredTruncationNote,
  weeklyReportWeekStateLabel,
  weeklyReportWeekStateTone,
} from "../../../src/weekly-reports/status";
import { Badge, Button, EmptyState, LoadingState, SectionLabel } from "../../../src/components/ui";
import { ScreenHeader } from "../../../src/components/ScreenHeader";

/**
 * The Reports hub — what used to be the Scorecard tab.
 *
 * Three things live under one roof now: the two scorecards (unchanged, still on their own routes so every
 * local draft and every emailed corrective-action deep link keeps resolving) and the weekly client
 * progress report. The scorecard entries push into that hidden route group rather than duplicating its
 * screens here; `start` tells its index which picker to open so the two entries stay distinct actions
 * instead of both landing on the same list.
 */
export default function ReportsHubScreen() {
  const router = useRouter();
  const { fetcher, user, activeOfficeId } = useAuth();
  const ownerKey = uploadOwnerKey(user?.id, activeOfficeId ?? user?.tenantId ?? undefined);

  const [drafts, setDrafts] = useState<WeeklyReportDraft[]>([]);
  const [opening, setOpening] = useState<string | null>(null);
  // `opening` drives the SPINNER and the disabled states; this ref is what actually bars a second door.
  //
  // Same hazard and same fix as `importInFlight` in reports/weekly/[draftId].tsx: React state does not
  // update before a second Pressable in the SAME native event batch re-reads it, so `if (opening) return`
  // sees null in both handlers and both proceed. `disabled={busyKey !== null && busyKey !== ownKey}` closes
  // the same-button case and nothing else — at rest every week button on this screen is enabled, so a
  // two-finger tap on two DIFFERENT weeks (or on a queue row and a Resume row) starts two doors: two
  // reads, two writes, and up to two conflict dialogs stacked on each other and answered in an order
  // nobody chose.
  const openInFlight = useRef(false);
  // Local draft reads are asynchronous and can outlive a focus session or a signed-in identity. A
  // monotonically increasing generation plus the current identity prevents an older read from
  // repopulating the list after blur, sign-out or an office switch.
  const draftLoadGeneration = useRef(0);
  const draftsFocused = useRef(false);
  const draftIdentity = useRef<{ userId: string | null; ownerKey: string }>({ userId: null, ownerKey: "" });
  draftIdentity.current = { userId: user?.id ?? null, ownerKey };

  const assignments = useQuery({
    queryKey: ["weekly-report-assignments", user?.id ?? "anon", activeOfficeId ?? "none"],
    queryFn: () => getWeeklyReportAssignments(fetcher),
    enabled: !!user,
  });

  // Never retain the previous account/office's local rows while authentication is being cleared or
  // swapped; this also invalidates an in-flight read before the focus effect starts the replacement.
  useEffect(() => {
    draftLoadGeneration.current += 1;
    setDrafts([]);
  }, [ownerKey, user?.id]);

  const reloadDrafts = useCallback(() => {
    const requestedUserId = user?.id ?? null;
    const requestedOwnerKey = ownerKey;
    const generation = ++draftLoadGeneration.current;
    if (!requestedOwnerKey || !requestedUserId) {
      setDrafts([]);
      return;
    }
    void listWeeklyReportDrafts(requestedOwnerKey)
      .then((list) => {
        const identity = draftIdentity.current;
        if (
          !draftsFocused.current ||
          generation !== draftLoadGeneration.current ||
          identity.userId !== requestedUserId ||
          identity.ownerKey !== requestedOwnerKey
        ) {
          return;
        }
        setDrafts([...list].sort((a, b) => b.updatedAt - a.updatedAt));
      })
      .catch(() => undefined);
  }, [ownerKey, user?.id]);

  useFocusEffect(
    useCallback(() => {
      draftsFocused.current = true;
      reloadDrafts();
      void assignments.refetch();
      return () => {
        draftsFocused.current = false;
        draftLoadGeneration.current += 1;
      };
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [reloadDrafts]),
  );

  function openDraft(draft: WeeklyReportDraft) {
    router.push({ pathname: "/(app)/reports/weekly/[draftId]", params: { draftId: draft.id } });
  }

  /**
   * Open a week: resume the local draft if there is one, else start from whatever the server holds.
   *
   * Which of those applies is decided by `weeklyReportOpenTarget`, where the reasoning lives — the rules
   * are freshness-sensitive (anything the server has a row for must be reconciled first, a purely local
   * draft must NOT be) and belong somewhere a test can reach them.
   */
  // The one route into the delivery screen for a report the client ALREADY received. The hub's
  // "Not delivered to the client" list cannot carry it — that query is `send_delivered_at IS NULL` — so
  // without this the re-mint action was reachable only while a send was failing or still in flight, which
  // is the opposite of when somebody asks for a replacement link.
  function openDelivery(reportId: string, projectName: string): void {
    router.push({ pathname: "/(app)/reports/delivery/[reportId]", params: { reportId, projectName } });
  }

  async function openWeek(
    project: WeeklyReportAssignment,
    weekOf: string,
    mode: "author" | "review" = "author",
  ) {
    if (!ownerKey || openInFlight.current) return;
    const key = `${project.weeklyReportProjectId}:${weekOf}`;
    openInFlight.current = true;
    setOpening(key);
    try {
      const target = weeklyReportOpenTarget({ project, weekOf, drafts });
      if (target.kind === "reconcile") {
        await openReconciled({
          reportId: target.reportId,
          projectName: project.projectName,
          mode,
          localDraftId: target.draftId,
        });
        return;
      }
      if (target.kind === "resume-local") {
        // Resolved FROM this list, so it is always found. Falling through to the fresh-draft path if it
        // ever is not beats returning with nothing having happened under the user's tap.
        const local = drafts.find((draft) => draft.id === target.draftId);
        if (local) {
          openDraft(local);
          return;
        }
      }

      const draft = createWeeklyReportDraft({
        id: newClientUploadId(),
        clientSubmissionId: newSubmissionId(),
        weeklyReportProjectId: project.weeklyReportProjectId,
        dealId: project.dealId,
        projectName: project.projectName,
        weekOf,
        // The predecessor OF THIS WEEK, so step 5 is a nudge rather than re-entry.
        //
        // Keyed by weekOf rather than taking the project-level value: completion % and weather
        // delays are cumulative, so filling a missed July week after August was filed would
        // otherwise seed July with August's figures — overstating that week's progress on a
        // document the client keeps as the record of it. Absent when no earlier week was filed,
        // which correctly leaves the fields blank rather than guessing.
        completionPercent: project.previousByWeekOf?.[weekOf]?.completionPercent ?? null,
        weatherDelayDays: project.previousByWeekOf?.[weekOf]?.weatherDelayDays ?? null,
        now: Date.now(),
      });
      await saveWeeklyReportDraft(ownerKey, draft, Date.now());
      setDrafts((current) => [draft, ...current]);
      openDraft(draft);
    } catch {
      Alert.alert("Couldn’t open that report", "Check your connection and try again.");
    } finally {
      openInFlight.current = false;
      setOpening(null);
    }
  }

  /** A PM opening a submitted report: the same wizard, everything editable, ending in Approve. */
  async function openForReview(item: WeeklyReportReviewItem) {
    if (!ownerKey || openInFlight.current) return;
    openInFlight.current = true;
    setOpening(item.reportId);
    try {
      await openReconciled({ reportId: item.reportId, projectName: item.projectName, mode: "review" });
    } finally {
      openInFlight.current = false;
      setOpening(null);
    }
  }

  /** Persist a resolved draft, put it at the top of the In-progress list, and open it. */
  async function commitDraft(draft: WeeklyReportDraft) {
    if (!ownerKey) return;
    try {
      // Reuses the local draft's id wherever there was one, so this OVERWRITES it rather than leaving
      // two drafts for one report sitting in the In-progress list.
      await saveWeeklyReportDraft(ownerKey, draft, Date.now());
    } catch {
      Alert.alert("Couldn’t open that report", "Check your connection and try again.");
      return;
    }
    setDrafts((current) => [draft, ...current.filter((d) => d.id !== draft.id)]);
    openDraft(draft);
  }

  /**
   * THE ONE DOOR onto a report the server knows about — the review queue, the project card, the
   * In-progress Resume link, and a local draft whose week turns out to have a row from another device.
   *
   * Nothing is decided here. `openWeeklyReportDoor` owns the read, the reconciliation and what gets
   * written; this supplies fetch, disk, navigation and the two dialogs. The decisions used to live inline
   * in this component, which no test in `mobile/` executes — and this app is not in CI and has no OTA, so
   * a deleted branch here ships to phones. See door.ts for the three that were silently mutable.
   */
  async function openReconciled(input: {
    reportId: string;
    projectName: string;
    mode: "author" | "review";
    localDraftId?: string | null;
  }) {
    if (!ownerKey) return;
    const local =
      (input.localDraftId ? drafts.find((draft) => draft.id === input.localDraftId) : undefined) ??
      drafts.find((draft) => draft.reportId === input.reportId) ??
      null;
    await openWeeklyReportDoor(
      { reportId: input.reportId, projectName: input.projectName, mode: input.mode, local },
      {
        read: async (reportId) => {
          const detail = await getWeeklyReport(fetcher, reportId, WEEKLY_REPORT_DOOR_READ_TIMEOUT_MS);
          return { report: detail.report, permissions: detail.permissions };
        },
        newDraftId: newClientUploadId,
        newClientSubmissionId: newSubmissionId,
        now: Date.now,
        commit: commitDraft,
        open: openDraft,
        // The second button is the READ PATH. A super whose week somebody else filed and had approved gets
        // `canEdit: false` here, and with a one-button alert the draft becomes unopenable for good: the
        // project card says "waiting", so there is no other door, and Discard — which deletes the writing
        // for ever — is the only working control left.
        refuse: ({ title, message, localCopy }) =>
          Alert.alert(
            title,
            message,
            localCopy
              ? [
                  { text: "OK", style: "cancel" },
                  { text: "Open my copy", onPress: () => openDraft(localCopy) },
                ]
              : undefined,
          ),
        choose: (prompt) =>
          new Promise<WeeklyReportDoorChoice>((resolve) => {
            Alert.alert(
              prompt.title,
              prompt.message,
              [
                { text: "Cancel", style: "cancel", onPress: () => resolve("cancel") },
                { text: prompt.keepLocalLabel, onPress: () => resolve("keep-local") },
                {
                  text: prompt.useServerLabel,
                  style: "destructive",
                  onPress: () => resolve("use-server"),
                },
              ],
              // Android's back gesture dismisses an alert without firing any button; without this the
              // promise never settles and the hub's controls stay disabled for the rest of the session.
              { cancelable: true, onDismiss: () => resolve("cancel") },
            );
          }),
        unavailable: () =>
          Alert.alert("Couldn’t open that report", "Check your connection and try again."),
      },
    );
  }

  /**
   * The In-progress "Resume" row.
   *
   * Guarded and marked busy like every other control on this screen. Any draft that names a server row now
   * does a read first, and an untapped-looking button for as long as that takes is how one tap becomes
   * four — four concurrent reads, four writes to the same draft id, and up to four stacked conflict
   * dialogs answered in an order nobody chose.
   */
  async function resumeDraft(draft: WeeklyReportDraft) {
    if (!draft.reportId) {
      // Purely local: no row exists anywhere, so there is nothing to reconcile and nothing to wait for.
      openDraft(draft);
      return;
    }
    if (openInFlight.current) return;
    openInFlight.current = true;
    setOpening(draft.id);
    try {
      await openReconciled({
        reportId: draft.reportId,
        projectName: draft.projectName,
        mode: draft.mode,
        localDraftId: draft.id,
      });
    } finally {
      openInFlight.current = false;
      setOpening(null);
    }
  }

  function confirmDiscard(draft: WeeklyReportDraft) {
    // Says what Discard actually destroys. It is the only destructive action on this screen and, for a
    // draft holding writing the server has never seen, the sentence below is the only warning anyone gets.
    const unsent = weeklyReportDiscardWarning({
      seededFrom: draft.seededFrom,
      signature: weeklyReportDraftSignature(draft),
    });
    Alert.alert(
      "Discard this weekly report?",
      // Deliberately specific about what survives. Photos imported from the device have already been
      // uploaded into the project gallery by the time they appear on a draft, and discarding here does
      // not remove them — saying so beats a user discovering it later.
      `This removes the in-progress weekly report for ${draft.projectName}, week of ${formatWeekOf(draft.weekOf)}.${unsent ? ` ${unsent}` : ""} Photos already imported into the project stay in the gallery.`,
      [
        { text: "Keep editing", style: "cancel" },
        {
          text: "Discard",
          style: "destructive",
          onPress: () => {
            void deleteWeeklyReportDraft(ownerKey, draft.id)
              .then(() => setDrafts((current) => current.filter((d) => d.id !== draft.id)))
              .catch(() => Alert.alert("Couldn’t discard", "Please try again."));
          },
        },
      ],
    );
  }

  const projects = assignments.data?.projects ?? [];
  const pendingReview = assignments.data?.pendingReview ?? [];
  // The queue is capped server-side. Never render the page as if the cap were the whole of somebody's
  // workload — approving does not clear a row, so an unreported cap hides new submissions indefinitely.
  const queueNote = weeklyReportQueueTruncationNote(
    pendingReview.length,
    assignments.data?.pendingReviewTotal,
  );
  // Weeks this PM SENT that the client has not been shown to have received. A separate list rather than
  // extra rows in the queue above: the two are different work ending in different buttons, and an older
  // app build — of which there are always some, since `mobile/` has no OTA — ignores an unknown key
  // entirely while it would have rendered a `sent` row under "Waiting on your review" with a dead tap.
  const undeliveredSends = assignments.data?.undeliveredSends ?? [];
  const undeliveredNote = weeklyReportUndeliveredTruncationNote(
    undeliveredSends.length,
    assignments.data?.undeliveredSendsTotal,
  );

  return (
    <SafeAreaView style={styles.safe} edges={["top"]}>
      <ScreenHeader />
      <ScrollView
        contentContainerStyle={styles.body}
        refreshControl={
          <RefreshControl
            refreshing={assignments.isRefetching}
            onRefresh={() => {
              reloadDrafts();
              void assignments.refetch();
            }}
            tintColor={theme.color.brandRed}
          />
        }
      >
        <View style={{ gap: theme.space.sm }}>
          <SectionLabel>Scorecards</SectionLabel>
          <HubEntry
            icon="clipboard-outline"
            title="Project Scorecard"
            subtitle="Score a jobsite against the eight categories"
            onPress={() =>
              router.push({ pathname: "/(app)/scorecards", params: { start: "project" } })
            }
          />
          <HubEntry
            icon="ribbon-outline"
            title="Leadership Scorecard"
            subtitle="Evaluate a project team"
            onPress={() =>
              router.push({ pathname: "/(app)/scorecards", params: { start: "leadership" } })
            }
          />
        </View>

        {/* ABOVE the review queue, deliberately. Everything below this block is work that has not gone out
            yet; every row in it is a client who is already owed a report somebody believes they sent. It is
            also the only place in T-Rock Cam that has ever said so — a `sent` week leaves the review queue
            and its project card reads "Sent", so before this the PM who pressed the button was told
            nothing, and the failure lived only on a CRM board they cannot open. */}
        {undeliveredSends.length > 0 ? (
          <View style={{ gap: theme.space.sm }}>
            <SectionLabel>Not delivered to the client</SectionLabel>
            {undeliveredNote ? <Text style={styles.queueNote}>{undeliveredNote}</Text> : null}
            {undeliveredSends.map((item) => (
              <UndeliveredSendRow
                key={item.reportId}
                item={item}
                disabled={opening !== null}
                onPress={() =>
                  router.push({
                    pathname: "/(app)/reports/delivery/[reportId]",
                    params: { reportId: item.reportId, projectName: item.projectName },
                  })
                }
              />
            ))}
          </View>
        ) : null}

        {pendingReview.length > 0 ? (
          <View style={{ gap: theme.space.sm }}>
            <SectionLabel>Waiting on your review</SectionLabel>
            {queueNote ? <Text style={styles.queueNote}>{queueNote}</Text> : null}
            {pendingReview.map((item) => (
              <View key={item.reportId} style={styles.card}>
                <Pressable
                  onPress={() => void openForReview(item)}
                  disabled={opening !== null}
                  accessibilityRole="button"
                  accessibilityLabel={`Review the weekly report for ${item.projectName}, week of ${formatWeekOf(item.weekOf)}`}
                  style={({ pressed }) => [styles.cardBody, pressed && { opacity: 0.7 }]}
                >
                  <View style={{ flex: 1 }}>
                    <Text style={styles.cardTitle} numberOfLines={1}>
                      {item.projectName}
                    </Text>
                    <Text style={styles.cardSub}>
                      Week of {formatWeekOf(item.weekOf)}
                      {item.authoredByName ? ` · ${item.authoredByName}` : ""}
                    </Text>
                  </View>
                  <Badge
                    label={weeklyReportWeekStateLabel(item.status)}
                    color={weeklyReportWeekStateTone(item.status).background}
                    textColor={weeklyReportWeekStateTone(item.status).text}
                  />
                </Pressable>
                {/* THE LAST STEP, AND THE ONE THAT USED TO BE MISSING. An approved report does not leave
                    this queue — only a SENT one does — so without a Send here an approval looked like the
                    end of the line and the row sat there until somebody with CRM access noticed. Offered
                    only at `approved`, because that is the only status the send accepts; the server
                    refuses anything else, and a button that always 409s is worse than no button.

                    A superintendent never sees this: the queue is the PM's, and the send is refused by
                    `canPublishWeeklyReport` in the service regardless of what this list draws. */}
                {item.status === "approved" ? (
                  <Button
                    // "Send", not "Send to client": the row already carries a project name, a week and an
                    // "Approved, not sent" badge, and a longer label squeezes all three on a phone. The
                    // full sentence is on the accessibility label, where it costs no width.
                    title="Send"
                    variant="ghost"
                    disabled={opening !== null}
                    accessibilityLabel={`Send the weekly report for ${item.projectName}, week of ${formatWeekOf(item.weekOf)}, to the client`}
                    onPress={() =>
                      router.push({
                        pathname: "/(app)/reports/send/[reportId]",
                        params: { reportId: item.reportId, projectName: item.projectName },
                      })
                    }
                    style={styles.sendButton}
                  />
                ) : null}
              </View>
            ))}
          </View>
        ) : null}

        {drafts.length > 0 ? (
          <View style={{ gap: theme.space.sm }}>
            <SectionLabel>In progress</SectionLabel>
            {drafts.map((draft) => (
              <View key={draft.id} style={styles.card}>
                <Pressable
                  // Same rule as the card, and NOT keyed on mode: any draft that names a server row is
                  // reconciled against it before it opens. Only a draft the server has never seen goes
                  // straight to disk.
                  onPress={() => void resumeDraft(draft)}
                  disabled={opening !== null}
                  style={({ pressed }) => [styles.cardBody, pressed && { opacity: 0.7 }]}
                  accessibilityRole="button"
                  accessibilityState={{ busy: opening === draft.id, disabled: opening !== null }}
                  accessibilityLabel={`Resume the weekly report for ${draft.projectName}, week of ${formatWeekOf(draft.weekOf)}`}
                >
                  <View style={{ flex: 1 }}>
                    <Text style={styles.cardTitle} numberOfLines={1}>
                      {draft.projectName}
                    </Text>
                    <Text style={styles.cardSub}>
                      {draft.mode === "review" ? "Reviewing · " : ""}Week of {formatWeekOf(draft.weekOf)} ·{" "}
                      {weeklyReportDraftSectionsFilled(draft)}/3 sections · {draft.photos.length} photo
                      {draft.photos.length === 1 ? "" : "s"}
                    </Text>
                  </View>
                  {opening === draft.id ? (
                    <ActivityIndicator size="small" color={theme.color.brandRed} />
                  ) : (
                    <Text style={styles.resume}>Resume</Text>
                  )}
                </Pressable>
                <Button
                  title="Discard"
                  variant="ghost"
                  // Not while a read for this list is in flight: the destructive control must not be the
                  // one thing that still responds while Resume is waiting on a signal.
                  disabled={opening !== null}
                  onPress={() => confirmDiscard(draft)}
                  style={styles.discardButton}
                />
              </View>
            ))}
          </View>
        ) : null}

        <View style={{ gap: theme.space.sm }}>
          <SectionLabel>Weekly report</SectionLabel>
          {assignments.isLoading ? (
            <LoadingState label="Loading your projects…" />
          ) : assignments.isError ? (
            <EmptyState
              title="Couldn’t load your projects"
              subtitle="Pull down to try again once you have a signal."
            />
          ) : projects.length === 0 ? (
            <EmptyState
              title="No weekly reports assigned"
              // Says WHERE the assignment comes from, because the fix is somebody else's action in the
              // CRM, not anything the super can do from this screen.
              subtitle="A project manager sets these up in the CRM and names the superintendent for each project."
            />
          ) : (
            projects.map((project) => (
              <ProjectCard
                key={project.weeklyReportProjectId}
                project={project}
                busyKey={opening}
                onOpenWeek={openWeek}
                onOpenDelivery={openDelivery}
              />
            ))
          )}
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

/**
 * One week the PM sent that has not reached the client.
 *
 * The chip is derived HERE, at render, from the four raw columns — not read off a label the server baked.
 * "Sending…", "Send failed" and "Send stuck" are one stored state read against a clock, and this app caches
 * the hub feed and paints it offline, so a server-side label would have the phone calling a half-hour-old
 * stall "Sending…" until somebody pulled to refresh.
 *
 * The whole row is one tap through to the delivery screen. There is no inline Retry: past the provider's
 * 24-hour window a retry is a genuinely second email to a paying client, and that is not a decision to
 * offer from a list row where a mis-tap costs a client an email they did not need.
 */
function UndeliveredSendRow({
  item,
  disabled,
  onPress,
}: {
  item: WeeklyReportUndeliveredSend;
  disabled: boolean;
  onPress: () => void;
}) {
  const state = weeklyReportDeliveryState(item);
  const label = weeklyReportDeliveryLabel(state);
  // Muted for a send still plausibly in flight; the platform's danger colour for the two that are not.
  // A queued job is not a fault, and colouring it as one teaches the PM to ignore the colour.
  const tone = state === "sending" ? theme.color.textMuted : theme.color.danger;
  return (
    <View style={styles.card}>
      <Pressable
        onPress={onPress}
        disabled={disabled}
        accessibilityRole="button"
        accessibilityState={{ disabled }}
        accessibilityLabel={`${label}: the weekly report for ${item.projectName}, week of ${formatWeekOf(item.weekOf)}. Open to retry or issue a correction.`}
        style={({ pressed }) => [styles.cardBody, pressed && { opacity: 0.7 }]}
      >
        <View style={{ flex: 1 }}>
          <Text style={styles.cardTitle} numberOfLines={1}>
            {item.projectName}
          </Text>
          <Text style={styles.cardSub}>
            {weeklyReportUndeliveredSummary(item, formatWeekOf(item.weekOf))}
          </Text>
        </View>
        <Badge label={label} color={theme.color.surfaceMuted} textColor={tone} />
      </Pressable>
    </View>
  );
}

function HubEntry({
  icon,
  title,
  subtitle,
  onPress,
}: {
  icon: React.ComponentProps<typeof Ionicons>["name"];
  title: string;
  subtitle: string;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={title}
      style={({ pressed }) => [styles.card, pressed && { opacity: 0.7 }]}
    >
      <Ionicons name={icon} size={22} color={theme.color.brandRed} />
      <View style={{ flex: 1 }}>
        <Text style={styles.cardTitle}>{title}</Text>
        <Text style={styles.cardSub}>{subtitle}</Text>
      </View>
      <Ionicons name="chevron-forward" size={20} color={theme.color.textMuted} />
    </Pressable>
  );
}

function ProjectCard({
  project,
  busyKey,
  onOpenWeek,
  onOpenDelivery,
}: {
  project: WeeklyReportAssignment;
  busyKey: string | null;
  onOpenWeek: (project: WeeklyReportAssignment, weekOf: string, mode: "author" | "review") => void;
  onOpenDelivery: (reportId: string, projectName: string) => void;
}) {
  const tone = weeklyReportWeekStateTone(project.currentState, project.daysLate);
  const currentKey = `${project.weeklyReportProjectId}:${project.currentWeekOf}`;
  // Derived rather than "openable unless sent", because the server's edit rules are not symmetric — an
  // approved report is the PM's alone, and a submitted one is with them. Offering the action anyway
  // would walk a superintendent into a 403 on a report that is simply not theirs any more.
  const action = weeklyReportProjectAction(project);
  const week = formatWeekOf(project.currentWeekOf);

  return (
    <View style={styles.projectCard}>
      <View style={styles.projectHeader}>
        <View style={{ flex: 1 }}>
          <Text style={styles.cardTitle} numberOfLines={1}>
            {project.projectName}
          </Text>
          <Text style={styles.cardSub}>
            {weeklyReportDueLabel(project.currentWeekOf, project.daysLate)}
            {project.clientName ? ` · ${project.clientName}` : ""}
          </Text>
        </View>
        <Badge
          label={weeklyReportWeekStateLabel(project.currentState)}
          color={tone.background}
          textColor={tone.text}
        />
      </View>

      {action.kind === "waiting" ? (
        // A line of text beats a button that fails: the state chip already says what is happening, this
        // says whose move it is.
        <Text style={styles.cardSub}>This week is with the project manager.</Text>
      ) : action.kind === "done" ? (
        // THE WEEK IS SENT, and this branch used to render nothing — which is how #17's actual case stayed
        // unreachable. The delivery screen was only ever linked from "Not delivered to the client", and
        // that list carries `send_delivered_at IS NULL`, so a report the client DID receive dropped out of
        // every path the phone had. "The client lost the email" happens weeks later, not during a failure.
        //
        // `lastSentReportId`, NOT `currentReportId`. The first version of this used the current week's id,
        // which the server defines for `currentWeekOf` alone — so the moment the cadence rolled over the
        // delivered report went unreachable all over again. Two reviewers caught that independently.
        //
        // GATED ON `isPm` because the action is: minting a client link needs `canPublishWeeklyReport`, and
        // an assigned superintendent is not that. They appear on this feed for their own projects and the
        // week reads `done` for them too, so without this they get a button that always ends in a 403 —
        // an app advertising something the person holding it cannot do.
        project.isPm && project.lastSentReportId ? (
          <Button
            title="Delivery & client link"
            variant="ghost"
            onPress={() => onOpenDelivery(project.lastSentReportId!, project.projectName)}
            accessibilityLabel={`Delivery status and client link for the week of ${
              project.lastSentWeekOf ? formatWeekOf(project.lastSentWeekOf) : week
            }`}
          />
        ) : null
      ) : (
        <Button
          title={
            action.kind === "start"
              ? `Start week of ${week}`
              : action.kind === "review"
                ? `Review week of ${week}`
                : `Open week of ${week}`
          }
          loading={busyKey === currentKey}
          disabled={busyKey !== null && busyKey !== currentKey}
          onPress={() => onOpenWeek(project, project.currentWeekOf, action.mode)}
        />
      )}

      {project.outstandingWeeks.length > 0 ? (
        <View style={{ gap: theme.space.sm }}>
          <Text style={styles.outstandingLabel}>
            {project.outstandingWeeks.length} earlier week
            {project.outstandingWeeks.length === 1 ? "" : "s"} still outstanding
            {/* Say so when the list was truncated — stopping silently at five reads as "nearly caught up". */}
            {project.hasMoreOutstandingWeeks ? ", plus older ones" : ""}
          </Text>
          <View style={styles.outstandingRow}>
            {project.outstandingWeeks.map((weekOf) => (
              <Button
                key={weekOf}
                title={formatWeekOf(weekOf)}
                variant="ghost"
                loading={busyKey === `${project.weeklyReportProjectId}:${weekOf}`}
                disabled={busyKey !== null && busyKey !== `${project.weeklyReportProjectId}:${weekOf}`}
                accessibilityLabel={`Fill in the missed weekly report for week of ${formatWeekOf(weekOf)}`}
                // Always AUTHORING: an outstanding week is by definition still owed, so there is nothing
                // for a PM to review on it. It may nonetheless already have a draft row on the server —
                // the wizard creates one on the photos step — which `weeklyReportOpenTarget` resolves and
                // resumes rather than creating a second report for the week.
                onPress={() => onOpenWeek(project, weekOf, "author")}
                style={styles.outstandingButton}
              />
            ))}
          </View>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: theme.color.surfaceApp },
  body: { padding: theme.space.lg, gap: theme.space.lg, paddingBottom: theme.space.xxl },
  card: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.space.md,
    backgroundColor: theme.color.surfaceCard,
    borderWidth: 1,
    borderColor: theme.color.border,
    borderRadius: theme.radius.md,
    padding: theme.space.md,
  },
  cardBody: { flex: 1, flexDirection: "row", alignItems: "center", gap: theme.space.md },
  projectCard: {
    gap: theme.space.md,
    backgroundColor: theme.color.surfaceCard,
    borderWidth: 1,
    borderColor: theme.color.border,
    borderRadius: theme.radius.md,
    padding: theme.space.md,
  },
  projectHeader: { flexDirection: "row", alignItems: "flex-start", gap: theme.space.sm },
  cardTitle: { fontFamily: theme.font.semibold, fontSize: 15, color: theme.color.textPrimary },
  cardSub: { fontFamily: theme.font.body, fontSize: 13, color: theme.color.textMuted, marginTop: 2 },
  resume: { fontFamily: theme.font.semibold, fontSize: 14, color: theme.color.brandRed },
  // Muted, not danger: a capped queue is information about this list, not a fault the PM has to fix.
  queueNote: { fontFamily: theme.font.body, fontSize: 13, color: theme.color.textMuted },
  discardButton: { minWidth: 76 },
  // Sized like Discard so the queue row and the In-progress row read as the same kind of card with the
  // same kind of trailing action, rather than one of them growing a full-width primary button.
  sendButton: { minWidth: 76 },
  outstandingLabel: { fontFamily: theme.font.body, fontSize: 13, color: theme.color.danger },
  outstandingRow: { flexDirection: "row", flexWrap: "wrap", gap: theme.space.sm },
  // Sized so a week chip does not stretch to the full row width like a primary action.
  outstandingButton: { minWidth: 96, minHeight: 44, paddingHorizontal: theme.space.md },
});
