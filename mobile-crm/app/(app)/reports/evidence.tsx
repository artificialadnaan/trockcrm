import React from "react";
import { ActivityIndicator, FlatList, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useQuery } from "@tanstack/react-query";
import { useLocalSearchParams } from "expo-router";
import { ApiError } from "../../../src/api/client";
import * as reportsApi from "../../../src/api/endpoints/reports";
import type { EvidenceMetric, WeekMode } from "../../../src/api/endpoints/reports";
import { useAuth } from "../../../src/auth/AuthContext";
import { useQueryScope } from "../../../src/auth/useOfficeId";
import { BackLink } from "../../../src/components/BackLink";
import { RetryBlock } from "../../../src/components/RetryBlock";
import { RetryNotice } from "../../../src/components/RetryNotice";
import { formatDate } from "../../../src/format";
import { useGoBack } from "../../../src/lib/go-back";
import { qk } from "../../../src/query/keys";
import { resolveDealDisplayNumber } from "../../../src/deal-display-number";
import { compactMoney } from "../../../src/report-format";
import { theme } from "../../../src/theme/theme";

/**
 * The deals behind one showcase number.
 *
 * A headline figure a rep cannot open is a number they have to take on trust, and the first question
 * anyone asks a report is "which ones?". The server already answers it — `/monday-showcase/evidence`
 * returns the same cohort the aggregate was computed from, which is what makes this a drill-down
 * rather than a second query that happens to look similar.
 *
 * TWO THINGS THE SERVER IS DELIBERATELY EXPLICIT ABOUT, and both are rendered rather than dropped:
 * `dateAxisLabel` says WHICH date these records sit on, because "won in the period" and "sent in the
 * period" are different axes and a bare list invites the wrong reading; and `total` carries the basis
 * for its value, so the sum shown here is labelled the same way the card that led here was.
 */
export default function ShowcaseEvidenceScreen() {
  const goBack = useGoBack("/(app)/reports");
  const { fetcher } = useAuth();
  const scope = useQueryScope();
  const params = useLocalSearchParams<{ metric?: string; mode?: string; period?: string }>();

  // Params arrive as strings from the URL; narrowing here keeps a hand-typed link from reaching the
  // endpoint as a 400 the screen cannot explain.
  const metric = (["won", "sent", "estimated"] as const).includes(params.metric as EvidenceMetric)
    ? (params.metric as EvidenceMetric)
    : "won";
  const mode = (["to_date", "completed", "mtd", "ytd"] as const).includes(params.mode as WeekMode)
    ? (params.mode as WeekMode)
    : "completed";

  const query = useQuery({
    queryKey: qk.showcaseEvidence(scope, metric, mode),
    queryFn: () => reportsApi.getShowcaseEvidence(fetcher, metric, mode),
    staleTime: 5 * 60_000,
  });

  const data = query.data;
  const offline = query.error instanceof ApiError && query.error.status === 0;
  /**
   * A refresh that fails AFTER records are on screen.
   *
   * TanStack keeps the previous list, so the error branch below is skipped and `isFetching` simply
   * goes false — the old records sit there looking current. Same shape the parent showcase screen
   * already handles, and the same one `list-state.ts` exists to stop.
   */
  const refreshFailed = Boolean(data && query.isError);

  return (
    <SafeAreaView style={styles.safe} edges={["top"]}>
      <View style={styles.header}>
        <BackLink label="Showcase" onPress={() => goBack()} />
        <Text accessibilityRole="header" style={styles.title}>
          {data?.metricLabel ?? "Deals"}
        </Text>
        {data ? <Text style={styles.sub}>{data.period.label}</Text> : null}
      </View>

      {!data && query.isLoading ? (
        <View style={styles.center}>
          <ActivityIndicator color={theme.color.brandRed} />
        </View>
      ) : !data ? (
        <View style={styles.center}>
          <RetryBlock
            testID="evidence-retry"
            title={offline ? "No signal" : "Couldn't load these deals"}
            body={offline ? "The list needs a connection." : undefined}
            onRetry={() => void query.refetch()}
            retrying={query.isFetching}
          />
        </View>
      ) : (
        <FlatList
          data={data.records}
          keyExtractor={(r) => r.id}
          contentContainerStyle={styles.body}
          refreshing={query.isFetching}
          onRefresh={() => void query.refetch()}
          ListHeaderComponent={
            <View style={styles.summary}>
              {refreshFailed ? (
                <RetryNotice
                  testID="evidence-refresh-failed"
                  placement="top"
                  message="Showing the last list — the refresh failed."
                  onRetry={() => void query.refetch()}
                />
              ) : null}
              <Text style={styles.summaryCount}>
                {data.total.count} {data.total.count === 1 ? "deal" : "deals"}
                {data.total.value !== null ? ` · ${compactMoney(data.total.value)}` : ""}
              </Text>
              {/* WHICH date these sit on. "Won in the period" and "sent in the period" are different
                  axes, and a list with no axis invites the reader to assume the wrong one. */}
              <Text style={styles.summaryAxis}>{data.dateAxisLabel}</Text>
              {data.total.basisLabel ? (
                <Text style={styles.summaryAxis}>{data.total.basisLabel}</Text>
              ) : null}
            </View>
          }
          ListFooterComponent={
            /**
             * THE WINDOW CAN MOVE UNDER A REPORT LEFT OPEN.
             *
             * Only `mode` is carried across, so the server recomputes from/to at request time. A
             * `to_date` report loaded before midnight opens a list covering an extra day; `completed`
             * becomes a different week on Sunday. The total then no longer reconciles with the figure
             * that was tapped.
             *
             * Passing an explicit from/to instead is not available: `assertShowcaseEvidenceAccess`
             * restricts an explicit window to directors and this screen is shown to reps. So the
             * period the report displayed is carried across for COMPARISON only, and a disagreement
             * is stated rather than left for someone to notice in the arithmetic. The real fix is
             * server-side and is filed.
             */
            params.period && params.period !== data.period.label ? (
              <Text testID="evidence-period-moved" style={styles.moved}>
                The report showed {params.period}; the period has since moved on, so these are the
                deals for {data.period.label}. Reopen the report for figures that match.
              </Text>
            ) : null
          }
          ListEmptyComponent={
            <Text style={styles.empty}>
              Nothing in this cohort for {data.period.label.toLowerCase()}.
            </Text>
          }
          renderItem={({ item }) => (
            <View style={styles.row}>
              <View style={styles.rowHead}>
                <Text style={styles.rowName} numberOfLines={2}>
                  {item.name}
                </Text>
                {item.value !== null ? (
                  <Text style={styles.rowValue}>{compactMoney(item.value)}</Text>
                ) : null}
              </View>
              {item.companyName ? (
                <Text
                  accessibilityLabel={item.companyName}
                  style={styles.rowCompany}
                  numberOfLines={1}
                >
                  {item.companyName}
                </Text>
              ) : null}
              <Text style={styles.rowMeta} numberOfLines={1}>
                {[
                  item.stageLabel,
                  item.repName,
                  item.cohortDate ? formatDate(item.cohortDate) : null,
                  // The canonical resolver, not `??`: a bid-board deal has projectNumber "" and its
                  // real number in dealNumber, and a HubSpot-imported deal must never show its id.
                  resolveDealDisplayNumber(item),
                ]
                  .filter(Boolean)
                  .join(" · ")}
              </Text>
            </View>
          )}
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
  sub: { ...theme.type.small, color: theme.color.textSecondary },
  center: { flex: 1, alignItems: "center", justifyContent: "center", padding: theme.space.lg },

  body: { padding: theme.space.lg, gap: theme.space.sm, paddingBottom: theme.space.xxl },
  summary: { gap: 2, marginBottom: theme.space.sm },
  summaryCount: { ...theme.type.h2, color: theme.color.textPrimary, fontVariant: ["tabular-nums"] },
  summaryAxis: { ...theme.type.small, color: theme.color.textMuted },
  empty: { ...theme.type.body, color: theme.color.textMuted },
  moved: {
    ...theme.type.small,
    color: theme.color.amberText,
    backgroundColor: theme.color.amberSurface,
    borderWidth: 1,
    borderColor: theme.color.amberBorder,
    borderRadius: theme.radius.md,
    padding: theme.space.md,
    marginTop: theme.space.md,
  },

  row: {
    backgroundColor: theme.color.surface,
    borderRadius: theme.radius.lg,
    borderWidth: 1,
    borderColor: theme.color.border,
    padding: theme.space.lg,
    gap: 4,
  },
  rowHead: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "flex-start",
    gap: theme.space.md,
  },
  rowName: { flex: 1, ...theme.type.title, color: theme.color.textPrimary },
  rowValue: { ...theme.type.title, color: theme.color.textPrimary, fontVariant: ["tabular-nums"] },
  rowCompany: { ...theme.type.caption, textTransform: "uppercase", color: theme.color.textMuted },
  rowMeta: { ...theme.type.small, color: theme.color.textSecondary },
});
