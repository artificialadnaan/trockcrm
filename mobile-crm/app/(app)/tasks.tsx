import React, { useState } from "react";
import { ActivityIndicator, FlatList, Pressable, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { useRouter } from "expo-router";
import { ApiError } from "../../src/api/client";
import * as tasksApi from "../../src/api/endpoints/tasks";
import type { TaskSection } from "../../src/api/endpoints/tasks";
import { useAuth } from "../../src/auth/AuthContext";
import { useQueryScope } from "../../src/auth/useOfficeId";
import { BackLink } from "../../src/components/BackLink";
import { RetryBlock } from "../../src/components/RetryBlock";
import { RetryNotice } from "../../src/components/RetryNotice";
import { resolveDealDisplayNumber } from "../../src/deal-display-number";
import { formatDate, formatDateTime } from "../../src/format";
import { useGoBack } from "../../src/lib/go-back";
import { sanitizeHubspotDealIdentifiers } from "../../src/deal-display-number";
import { taskEffectiveDate, taskPriorityLabel, taskStatusLabel } from "../../src/task-display";
import { refreshFailed as pageRefreshFailed, shouldLoadNextPage } from "../../src/paging";
import { qk } from "../../src/query/keys";
import { theme } from "../../src/theme/theme";

/**
 * The four sections, and which of them the counts endpoint can actually badge.
 *
 * `/tasks/counts` answers overdue / today / upcoming / completed / completedThisWeek — a legacy shape
 * that predates the section vocabulary. Indexing it by section key read `undefined` for this_week and
 * later, so those two badges could never appear however many tasks sat behind them. Stated here rather
 * than discovered: a section either has a count or shows none, and neither pretends.
 */
const SECTIONS: { key: TaskSection; label: string; countKey?: "overdue" | "today" }[] = [
  { key: "overdue", label: "Overdue", countKey: "overdue" },
  { key: "today", label: "Today", countKey: "today" },
  { key: "this_week", label: "This week" },
  { key: "later", label: "Later" },
];

/**
 * The rep's to-do list.
 *
 * Of everything the web offers, this has the strongest claim to belonging on a phone: it is the one
 * surface whose whole content is "what needs me, now", read between other things.
 *
 * THE SECTIONS ARE THE SERVER'S. `TASK_SECTIONS` in tasks/service.ts computes overdue / today /
 * this_week / later against America/Chicago, and the split is a business-timezone rule — a rep in the
 * field at 11pm must see the same "today" the office does. Recomputing it here from `dueDate` would be
 * a second implementation of that rule, and this codebase has been bitten by exactly that shape
 * repeatedly.
 */
export default function TasksScreen() {
  const router = useRouter();
  const goBack = useGoBack("/(app)/dashboard");
  const { fetcher } = useAuth();
  const scope = useQueryScope();
  const [section, setSection] = useState<TaskSection>("today");

  /**
   * PAGED. A fifty-row cap silently omitted every later task, and a hidden overdue item is worse here
   * than anywhere else in the app — this list's whole claim is that it shows what needs you.
   */
  const query = useInfiniteQuery({
    queryKey: qk.tasks(scope, { section }),
    initialPageParam: 1,
    queryFn: ({ pageParam }) => tasksApi.listTasks(fetcher, { section, page: pageParam }),
    getNextPageParam: (last, all) => (last.tasks.length < 50 ? undefined : all.length + 1),
  });

  const counts = useQuery({
    queryKey: qk.taskCounts(scope),
    queryFn: () => tasksApi.getTaskCounts(fetcher),
    staleTime: 60_000,
  });

  const tasks = (query.data?.pages ?? []).flatMap((p) => p.tasks);
  const blocking = !query.data;
  // NOT a bare `isError`: a failed PAGE sets that too, and the header would then claim a refresh had
  // failed while the footer correctly reported the real failure. One failure, one message.
  const refreshFailed = pageRefreshFailed(query);
  /**
   * The counts are a SEPARATE query, and they fail separately.
   *
   * TanStack keeps `counts.data` when a later refetch fails, so the section badges kept rendering the
   * last totals with nothing saying they were old. That is worse here than a stale row: a rep reads
   * "Overdue 0", skips the section, and the section has work in it. The number is withdrawn rather
   * than corrected — an absent badge says "unknown", a wrong one says "nothing to do".
   */
  const countsStale = counts.isError;
  const offline = query.error instanceof ApiError && query.error.status === 0;

  return (
    <SafeAreaView style={styles.safe} edges={["top", "bottom"]}>
      <View style={styles.header}>
        <BackLink label="Home" onPress={() => goBack()} />
        <Text accessibilityRole="header" style={styles.title}>
          Tasks
        </Text>
      </View>

      {/* Outside the loading branch, so switching section never removes the control that switches it. */}
      <View style={styles.sections}>
        {SECTIONS.map((s) => {
          const active = s.key === section;
          const n = s.countKey && !countsStale ? counts.data?.[s.countKey] : undefined;
          return (
            <Pressable
              key={s.key}
              testID={`tasks-section-${s.key}`}
              onPress={() => setSection(s.key)}
              accessibilityRole="button"
              accessibilityState={{ selected: active }}
              accessibilityLabel={n != null ? `${s.label}, ${n}` : s.label}
              style={[styles.section, active && styles.sectionActive]}
            >
              <Text style={[styles.sectionText, active && styles.sectionTextActive]}>
                {s.label}
                {n != null ? ` ${n}` : ""}
              </Text>
            </Pressable>
          );
        })}
      </View>

      {blocking && query.isLoading ? (
        <View style={styles.center}>
          <ActivityIndicator color={theme.color.brandRed} />
        </View>
      ) : blocking ? (
        <View style={styles.center}>
          <RetryBlock
            testID="tasks-retry"
            title={offline ? "No signal" : "Couldn't load tasks"}
            onRetry={() => void query.refetch()}
            retrying={query.isFetching}
          />
        </View>
      ) : (
        <FlatList
          data={tasks}
          onEndReachedThreshold={0.5}
          onEndReached={() => {
            if (shouldLoadNextPage(query)) void query.fetchNextPage();
          }}
          ListFooterComponent={
            query.isFetchingNextPage ? (
              <ActivityIndicator color={theme.color.brandRed} style={styles.more} />
            ) : query.isFetchNextPageError ? (
              <RetryNotice
                testID="tasks-more-failed"
                placement="bottom"
                message="Couldn't load more. Tap to try again."
                onRetry={() => void query.fetchNextPage()}
              />
            ) : null
          }
          keyExtractor={(t) => t.id}
          contentContainerStyle={styles.body}
          refreshing={query.isRefetching}
          onRefresh={() => void Promise.all([query.refetch(), counts.refetch()])}
          ListHeaderComponent={
            /* BOTH, not either. The list and the counts are separate endpoints that fail separately,
               and an exclusive ternary would hide whichever failure came second — including the case
               where the rows refreshed fine and only the badges are missing. */
            refreshFailed || countsStale ? (
              <>
                {refreshFailed ? (
                  <RetryNotice
                    testID="tasks-refresh-failed"
                    placement="top"
                    message="Showing the last list — the refresh failed."
                    onRetry={() => void query.refetch()}
                  />
                ) : null}
                {countsStale ? (
                  <RetryNotice
                    testID="tasks-counts-failed"
                    placement="top"
                    message="Section totals unavailable. Tap to try again."
                    onRetry={() => void counts.refetch()}
                  />
                ) : null}
              </>
            ) : null
          }
          ListEmptyComponent={
            <Text style={styles.empty}>
              {section === "overdue" ? "Nothing overdue." : "Nothing here."}
            </Text>
          }
          renderItem={({ item }) => {
            const dealNumber = resolveDealDisplayNumber(item);
            /**
             * The date the SERVER sorted by, not a guess at it. `updateTask` permits a due date on a
             * row that is still scheduled, so `dueDate ?? scheduledFor` could show one date while the
             * list was ordered by the other — a row displaying Friday sitting between Monday and
             * Tuesday, which reads as a broken sort.
             */
            const when = taskEffectiveDate(item);
            // Time only for `scheduled_for`, which is a timestamptz someone picked an hour on. A
            // `due_date` is a Postgres `date`; showing "12:00 AM" on one would invent a precision the
            // column does not have.
            const whenText =
              when.value == null
                ? null
                : when.source === "scheduledFor"
                  ? formatDateTime(when.value)
                  : formatDate(when.value);
            /**
             * Priority and lifecycle FIRST, because they change what a rep does with the row.
             *
             * The list groups by date and nothing else, so two rows with the same title and date could
             * be an urgent task and a low one, or an actionable task and one blocked on somebody else.
             * `normal` and `pending` stay silent on purpose — a marker on every row distinguishes none
             * of them.
             */
            const priority = taskPriorityLabel(item.priority);
            const lifecycle = taskStatusLabel(item.status);
            const meta = [
              priority,
              lifecycle,
              item.dealName,
              dealNumber,
              whenText,
              item.assignedToName,
            ]
              .filter(Boolean)
              .join(" · ");
            /**
             * A deal if there is one, otherwise the CONTACT — the web task list falls back the same
             * way, and the server creates several contact-scoped task types. Treating "no deal" as
             * "not openable" made every one of those a dead row beside a record this app can show.
             */
            /**
             * The title, with any raw HubSpot id taken out of it.
             *
             * The deal-number metadata already suppresses these — `resolveDealDisplayNumber` refuses to
             * return an HS- number — but the daily close-date rule BUILDS its title by interpolating
             * `context.dealNumber` into a sentence, so the row published under the metadata what the
             * metadata was hiding, and the accessibility label read the digits out. The web task list
             * has sanitized these since it shipped; this is the same rule, mirrored.
             */
            const title = sanitizeHubspotDealIdentifiers(item.title) || item.title;
            const description = sanitizeHubspotDealIdentifiers(item.description);
            const target = item.dealId
              ? `/(app)/deals/${item.dealId}`
              : item.contactId
                ? `/(app)/contacts/${item.contactId}`
                : null;
            const content = (
              <>
                <Text style={styles.taskTitle} numberOfLines={2}>
                  {title}
                </Text>
                {meta ? (
                  <Text style={styles.taskMeta} numberOfLines={2}>
                    {meta}
                  </Text>
                ) : null}
                {/* THE INSTRUCTION, where there is one.
                    Server-generated tasks put the actionable part in `description` — the inbound-email
                    disambiguation task lists its candidate deals ONLY there — and this app has no task
                    detail screen to open, so a row without it left the rep unable to find out what the
                    task wanted. Sanitized on the same rule as the title: a generated description
                    interpolates the same deal identifiers. */}
                {description ? (
                  <Text style={styles.taskDescription} numberOfLines={3}>
                    {description}
                  </Text>
                ) : null}
              </>
            );
            /**
             * A task opens its DEAL, because that is the only destination this app has for one — there
             * is no task detail screen yet. A task with no deal is not pressable rather than pressable
             * and inert: a control that does nothing is worse than one that is plainly absent.
             */
            if (!target) return <View style={styles.task}>{content}</View>;
            return (
              <Pressable
                testID={`task-${item.id}`}
                onPress={() => router.push(target)}
                accessibilityRole="button"
                accessibilityLabel={[
                  title,
                  description,
                  meta,
                  item.dealId ? "Open the deal." : "Open the contact.",
                ]
                  .filter(Boolean)
                  .join(", ")}
                style={styles.task}
              >
                {content}
              </Pressable>
            );
          }}
        />
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: theme.color.canvas },
  header: {
    backgroundColor: theme.color.chrome,
    paddingHorizontal: theme.space.lg,
    paddingBottom: theme.space.md,
    borderBottomWidth: 2,
    borderBottomColor: theme.color.brandRed,
  },
  title: { ...theme.type.h1, color: theme.color.textPrimary, marginTop: theme.space.xs },
  center: { flex: 1, alignItems: "center", justifyContent: "center", padding: theme.space.lg },
  more: { paddingVertical: theme.space.lg },
  sections: {
    flexDirection: "row",
    gap: theme.space.sm,
    padding: theme.space.lg,
    paddingBottom: theme.space.sm,
  },
  section: {
    minHeight: 44,
    justifyContent: "center",
    flexBasis: "22%",
    flexGrow: 1,
    alignItems: "center",
    borderRadius: theme.radius.sm,
    borderWidth: 1,
    borderColor: theme.color.border,
    backgroundColor: theme.color.surfaceMuted,
    paddingHorizontal: theme.space.xs,
  },
  sectionActive: { backgroundColor: theme.color.surfaceRaised, borderColor: theme.color.borderStrong },
  sectionText: { ...theme.type.caption, color: theme.color.textMuted },
  sectionTextActive: { color: theme.color.textPrimary },
  body: { padding: theme.space.lg, paddingTop: theme.space.sm, gap: theme.space.sm },
  empty: { ...theme.type.body, color: theme.color.textMuted },
  task: {
    minHeight: 44,
    backgroundColor: theme.color.surface,
    borderRadius: theme.radius.lg,
    borderWidth: 1,
    borderColor: theme.color.border,
    padding: theme.space.lg,
    gap: 2,
  },
  taskTitle: { ...theme.type.title, color: theme.color.textPrimary },
  taskMeta: { ...theme.type.small, color: theme.color.textSecondary },
  taskDescription: { ...theme.type.small, color: theme.color.textMuted, marginTop: theme.space.xs },
});
