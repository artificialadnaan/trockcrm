import React, { useCallback, useEffect, useRef, useState } from "react";
import { Alert, Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useFocusEffect, useRouter } from "expo-router";
import { useQuery } from "@tanstack/react-query";
import { Ionicons } from "@expo/vector-icons";
import { theme } from "../../../src/theme/theme";
import { useAuth } from "../../../src/auth/AuthContext";
import { getWeeklyReport, getWeeklyReportAssignments } from "../../../src/api/endpoints";
import type { WeeklyReportAssignment, WeeklyReportReviewItem } from "../../../src/api/types";
import { newClientUploadId, uploadOwnerKey } from "../../../src/capture/upload-queue";
import { newSubmissionId } from "../../../src/scorecards/ids";
import {
  createWeeklyReportDraft,
  weeklyReportDraftFromDetail,
  weeklyReportDraftSectionsFilled,
  type WeeklyReportDraft,
} from "../../../src/weekly-reports/draft";
import {
  deleteWeeklyReportDraft,
  listWeeklyReportDrafts,
  saveWeeklyReportDraft,
} from "../../../src/weekly-reports/draft-store";
import {
  formatWeekOf,
  weeklyReportDueLabel,
  weeklyReportProjectAction,
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
   * The LOCAL draft wins when both exist. It is the durability unit — it may carry text typed on a
   * jobsite with no signal that has not reached the server yet — so seeding from the server copy would
   * quietly discard exactly the work this store exists to protect.
   */
  async function openWeek(
    project: WeeklyReportAssignment,
    weekOf: string,
    existingReportId: string | null,
    mode: "author" | "review" = "author",
  ) {
    if (!ownerKey || opening) return;
    const key = `${project.weeklyReportProjectId}:${weekOf}`;
    setOpening(key);
    try {
      const local = drafts.find(
        (draft) => draft.weeklyReportProjectId === project.weeklyReportProjectId && draft.weekOf === weekOf,
      );
      if (local) {
        openDraft(local);
        return;
      }

      let draft: WeeklyReportDraft;
      if (existingReportId) {
        const detail = await getWeeklyReport(fetcher, existingReportId);
        // The SERVER's answer to "may this person still write this?", not a guess from the hub row —
        // which can be minutes stale. A report approved (or sent) while this list sat on screen is no
        // longer the superintendent's, and opening it would walk them into a 403 several steps in, after
        // they had already retyped a section.
        if (!detail.permissions.canEdit) {
          Alert.alert(
            "This report has moved on",
            "Somebody has already reviewed or sent it. Pull down to refresh.",
          );
          return;
        }
        draft = weeklyReportDraftFromDetail({
          id: newClientUploadId(),
          clientSubmissionId: newSubmissionId(),
          projectName: project.projectName,
          mode,
          report: detail.report,
          now: Date.now(),
        });
      } else {
        draft = createWeeklyReportDraft({
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
      }
      await saveWeeklyReportDraft(ownerKey, draft, Date.now());
      setDrafts((current) => [draft, ...current]);
      openDraft(draft);
    } catch {
      Alert.alert("Couldn’t open that report", "Check your connection and try again.");
    } finally {
      setOpening(null);
    }
  }

  /**
   * A PM opening a submitted report: the same wizard, everything editable, ending in Approve.
   *
   * Unlike authoring, this ALWAYS reseeds from the server. The local-draft-wins rule protects a
   * superintendent's own offline work; in review mode the authoritative copy belongs to somebody else,
   * and a stale review draft is a live data-loss bug — the PM bounces a report back, the super rewrites
   * it and resubmits, the PM taps their day-old card, and Approve replays a `PATCH` of explicit nulls
   * plus a whole-set photo `PUT` over the super's new work while the status still reads "approved".
   *
   * The local copy is used only when the fetch fails, so a PM with no signal still sees what they had
   * rather than being locked out.
   */
  async function openForReview(item: WeeklyReportReviewItem) {
    if (!ownerKey || opening) return;
    setOpening(item.reportId);
    const local = drafts.find((draft) => draft.reportId === item.reportId && draft.mode === "review");
    try {
      const detail = await getWeeklyReport(fetcher, item.reportId);
      // The gate is "can this row's FINAL ACTION complete", which is not one permission flag.
      //
      //   pending_review -> the action is Approve, so it needs canApprove.
      //   approved       -> the action is Save changes, so it needs canEdit. canApprove is FALSE here,
      //                     because the ladder has no approved -> approved self-transition — gating on
      //                     canApprove alone locked the PM out of approved-but-unsent reports, which
      //                     this queue deliberately carries and which are only reachable from here for
      //                     a prior week.
      //   draft          -> bounced back to the super. A PM still has canEdit, so an edit-only check
      //                     would open review mode, walk them through captions and photos, and the
      //                     final tap would PATCH content and REPLACE the photo set before the illegal
      //                     draft -> approved transition 409'd. The mutations land; only the
      //                     transition fails.
      //
      // So: refuse when the report cannot be written at all, and refuse a review row that has gone
      // back to draft. Everything else opens.
      const { canEdit, canApprove } = detail.permissions;
      const wentBackToDraft = detail.report.status === "draft";
      if (!canEdit || (wentBackToDraft && !canApprove)) {
        Alert.alert(
          "This report has moved on",
          wentBackToDraft
            ? "It went back to the superintendent for changes. Pull down to refresh."
            : "It has already been sent, or somebody else reviewed it. Pull down to refresh.",
        );
        return;
      }
      const report = detail.report;
      const draft = weeklyReportDraftFromDetail({
        id: local?.id ?? newClientUploadId(),
        clientSubmissionId: local?.clientSubmissionId ?? newSubmissionId(),
        projectName: item.projectName,
        mode: "review",
        report,
        now: Date.now(),
      });
      // Reuses the stale draft's id, so this OVERWRITES it rather than leaving two review drafts for one
      // report sitting in the In-progress list.
      await saveWeeklyReportDraft(ownerKey, draft, Date.now());
      setDrafts((current) => [draft, ...current.filter((d) => d.id !== draft.id)]);
      openDraft(draft);
    } catch {
      if (local) {
        openDraft(local);
        return;
      }
      Alert.alert("Couldn’t open that report", "Check your connection and try again.");
    } finally {
      setOpening(null);
    }
  }

  function confirmDiscard(draft: WeeklyReportDraft) {
    Alert.alert(
      "Discard this weekly report?",
      // Deliberately specific about what survives. Photos imported from the device have already been
      // uploaded into the project gallery by the time they appear on a draft, and discarding here does
      // not remove them — saying so beats a user discovering it later.
      `This removes the in-progress weekly report for ${draft.projectName}, week of ${formatWeekOf(draft.weekOf)}. Photos already imported into the project stay in the gallery.`,
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

        {pendingReview.length > 0 ? (
          <View style={{ gap: theme.space.sm }}>
            <SectionLabel>Waiting on your review</SectionLabel>
            {pendingReview.map((item) => (
              <Pressable
                key={item.reportId}
                onPress={() => void openForReview(item)}
                disabled={opening !== null}
                accessibilityRole="button"
                accessibilityLabel={`Review the weekly report for ${item.projectName}, week of ${formatWeekOf(item.weekOf)}`}
                style={({ pressed }) => [styles.card, pressed && { opacity: 0.7 }]}
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
            ))}
          </View>
        ) : null}

        {drafts.length > 0 ? (
          <View style={{ gap: theme.space.sm }}>
            <SectionLabel>In progress</SectionLabel>
            {drafts.map((draft) => (
              <View key={draft.id} style={styles.card}>
                <Pressable
                  onPress={() => openDraft(draft)}
                  style={styles.cardBody}
                  accessibilityRole="button"
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
                  <Text style={styles.resume}>Resume</Text>
                </Pressable>
                <Button
                  title="Discard"
                  variant="ghost"
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
              />
            ))
          )}
        </View>
      </ScrollView>
    </SafeAreaView>
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
}: {
  project: WeeklyReportAssignment;
  busyKey: string | null;
  onOpenWeek: (
    project: WeeklyReportAssignment,
    weekOf: string,
    reportId: string | null,
    mode: "author" | "review",
  ) => void;
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
      ) : action.kind === "done" ? null : (
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
          onPress={() =>
            onOpenWeek(project, project.currentWeekOf, project.currentReportId, action.mode)
          }
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
                // Always authoring: an outstanding week by definition has no report yet, so there is
                // nothing for a PM to review on it.
                onPress={() => onOpenWeek(project, weekOf, null, "author")}
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
  discardButton: { minWidth: 76 },
  outstandingLabel: { fontFamily: theme.font.body, fontSize: 13, color: theme.color.danger },
  outstandingRow: { flexDirection: "row", flexWrap: "wrap", gap: theme.space.sm },
  // Sized so a week chip does not stretch to the full row width like a primary action.
  outstandingButton: { minWidth: 96, minHeight: 44, paddingHorizontal: theme.space.md },
});
