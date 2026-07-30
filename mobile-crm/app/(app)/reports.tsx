import React, { useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useQuery } from "@tanstack/react-query";
import { ApiError } from "../../src/api/client";
import * as reportsApi from "../../src/api/endpoints/reports";
import type { DepartmentMetric, WeekMode } from "../../src/api/endpoints/reports";
import { useAuth } from "../../src/auth/AuthContext";
import { useQueryScope } from "../../src/auth/useOfficeId";
import { BackLink } from "../../src/components/BackLink";
import { RetryBlock } from "../../src/components/RetryBlock";
import { RetryNotice } from "../../src/components/RetryNotice";
import { useGoBack } from "../../src/lib/go-back";
import { qk } from "../../src/query/keys";
import {
  WEEK_MODES,
  compactMoney,
  deltaChip,
  departmentCountLabel,
  heroBasisLines,
  sparklineHeights,
} from "../../src/report-format";
import { theme } from "../../src/theme/theme";

/**
 * The Monday Showcase, as much of it as belongs on a phone.
 *
 * The web renders this payload five different ways behind a variant picker, all of them wide: a
 * forecast ladder, a per-rep table, evidence drill-downs. None of that survives a 390pt screen, and
 * shrinking a table until it fits is how you get a report nobody reads.
 *
 * So this is another slice of the same payload rather than a smaller copy of the page: the three
 * numbers the Monday meeting opens on, and the four department metrics with their direction of travel.
 * A rep checks it standing up before a first call; a director checks it before the meeting. Anyone who
 * needs the ladder or the rep table is at a desk, where the web version already exists.
 *
 * ONE REQUEST. The server always computes the full payload, so the period toggle is a refetch with a
 * different `mode` rather than four endpoints.
 */
export default function ReportsScreen() {
  const goBack = useGoBack("/(app)/dashboard");
  const { fetcher } = useAuth();
  const scope = useQueryScope();
  /**
   * "completed", matching the web's `DEFAULT_WEEK_MODE` (client/src/pages/reports/week-mode.ts:12).
   *
   * Not a style choice. On a Monday morning `to_date` is a few hours old and usually empty, which is
   * precisely when this report is opened — and defaulting differently from the web would mean the same
   * person reading two different numbers for "the showcase" depending on which screen they used.
   */
  const [mode, setMode] = useState<WeekMode>("completed");

  const query = useQuery({
    queryKey: qk.mondayShowcase(scope, mode),
    queryFn: () => reportsApi.getMondayShowcase(fetcher, mode),
    // A report is a statement about a moment and this one is cheap to re-ask; five minutes keeps the
    // toggle instant without serving Monday's numbers on Tuesday.
    staleTime: 5 * 60_000,
  });

  const data = query.data;
  // `!data`, not `isError` — TanStack keeps the previous payload when a refetch fails, and replacing a
  // readable report with an error screen because the SECOND load failed is the mistake list-state.ts
  // exists to stop. A stale-but-present report says so inline instead.
  const blocking = !data;
  const refreshFailed = Boolean(data && query.isError);
  const offline = query.error instanceof ApiError && query.error.status === 0;

  return (
    <SafeAreaView style={styles.safe} edges={["top"]}>
      <View style={styles.header}>
        <BackLink label="Home" onPress={() => goBack()} />
        <Text accessibilityRole="header" accessibilityLabel="Monday showcase" style={styles.title}>
          Monday showcase
        </Text>
      </View>

      {/* The toggle lives OUTSIDE the loading branch so switching period never removes the control
          that switches period — the same trap the prospect screen's spinner fell into. */}
      <View style={styles.modes}>
        {WEEK_MODES.map((m) => {
          const active = m.key === mode;
          return (
            <Pressable
              key={m.key}
              testID={`showcase-mode-${m.key}`}
              onPress={() => setMode(m.key)}
              accessibilityRole="button"
              accessibilityState={{ selected: active }}
              style={[styles.mode, active && styles.modeActive]}
            >
              <Text style={[styles.modeText, active && styles.modeTextActive]}>{m.label}</Text>
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
            testID="showcase-retry"
            title={offline ? "No signal" : "Couldn't load the showcase"}
            body={offline ? "The report needs a connection." : undefined}
            onRetry={() => void query.refetch()}
            retrying={query.isFetching}
          />
        </View>
      ) : (
        <ScrollView
          contentContainerStyle={styles.body}
          /**
           * PULL TO REFRESH, because `staleTime` alone cannot refresh anything here.
           *
           * `refetchOnWindowFocus` is false app-wide (app/_layout.tsx:23), so five minutes marks the
           * query stale and nothing acts on it while the screen stays mounted. A rep who opens the
           * report before a meeting, or backgrounds the app on it, would read the same figures
           * indefinitely with no way to ask for new ones.
           */
          refreshControl={
            <RefreshControl
              refreshing={query.isFetching}
              onRefresh={() => void query.refetch()}
              tintColor={theme.color.textMuted}
            />
          }
        >
          {refreshFailed ? (
            <RetryNotice
              testID="showcase-refresh-failed"
              placement="top"
              message="Showing the last figures — the refresh failed."
              onRetry={() => void query.refetch()}
            />
          ) : null}

          <Text style={styles.period}>{data.period.label}</Text>

          {/* ---- The three the meeting opens on ---- */}
          <View style={styles.heroRow}>
            <HeroCell label="Won" metric={data.execHero.won} />
            <HeroCell label="Sent" metric={data.execHero.sent} />
            <HeroCell label="Estimated" metric={data.execHero.estimated} />
          </View>

          {/* The basis is not decoration, and it is not shared: Won is awarded-first while Sent and
              Estimated are a best current estimate. Printing only Won's label under all three read as
              one caption for the row. */}
          {heroBasisLines([
            { label: "Won", basisLabel: data.execHero.won.value.basisLabel },
            { label: "Sent", basisLabel: data.execHero.sent.value.basisLabel },
            { label: "Estimated", basisLabel: data.execHero.estimated.value.basisLabel },
          ]).map((line) => (
            <Text key={line} style={styles.basis}>
              {line}
            </Text>
          ))}

          <Text style={styles.sectionLabel}>DEPARTMENTS</Text>
          {data.departments.map((d) => (
            <DepartmentCard key={d.key} metric={d} mode={mode} />
          ))}

          {data.notes.length ? (
            <View style={styles.notes}>
              {data.notes.map((n) => (
                <Text key={n} style={styles.note}>
                  • {n}
                </Text>
              ))}
            </View>
          ) : null}
        </ScrollView>
      )}
    </SafeAreaView>
  );
}

function HeroCell({ label, metric }: { label: string; metric: reportsApi.ExecHeroMetric }) {
  return (
    <View style={styles.hero}>
      <Text accessibilityLabel={label} style={styles.heroLabel}>
        {label}
      </Text>
      <Text style={styles.heroValue}>{compactMoney(metric.value.amount)}</Text>
      <Text style={styles.heroCount}>
        {metric.count} {metric.count === 1 ? "deal" : "deals"}
      </Text>
    </View>
  );
}

function DepartmentCard({ metric, mode }: { metric: DepartmentMetric; mode: WeekMode }) {
  const chip = deltaChip(metric, mode);
  const heights = sparklineHeights(metric.sparkline);

  return (
    <View style={styles.card}>
      <View style={styles.cardHead}>
        <Text accessibilityLabel={metric.label} style={styles.cardLabel}>
          {metric.label}
        </Text>
        {chip ? (
          <Text
            style={[
              styles.chip,
              chip.tone === "up" && styles.chipUp,
              chip.tone === "down" && styles.chipDown,
            ]}
          >
            {chip.label}
          </Text>
        ) : null}
      </View>

      <View style={styles.cardBody}>
        <Text style={styles.cardCount}>{departmentCountLabel(metric)}</Text>
        {metric.value ? <Text style={styles.cardValue}>{compactMoney(metric.value.amount)}</Text> : null}
      </View>

      {/**
        * Eight weeks, drawn with plain Views.
        *
        * There is no svg or animation library in this app and eight bars do not justify adding one.
        * Hidden from the accessibility tree: a bar chart with no labels is noise to a screen reader,
        * and the count and delta above it already carry the same information in words.
        */}
      {heights.length ? (
        <View style={styles.spark} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
          {heights.map((h, i) => (
            <View key={i} style={styles.sparkSlot}>
              <View style={[styles.sparkBar, { height: `${Math.round(h * 100)}%` }]} />
            </View>
          ))}
        </View>
      ) : null}

      {metric.deferred ? <Text style={styles.deferred}>Not measured yet.</Text> : null}
    </View>
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

  modes: {
    flexDirection: "row",
    gap: theme.space.sm,
    padding: theme.space.lg,
    paddingBottom: theme.space.sm,
  },
  mode: {
    minHeight: 44,
    justifyContent: "center",
    flex: 1,
    alignItems: "center",
    borderRadius: theme.radius.sm,
    borderWidth: 1,
    borderColor: theme.color.border,
    backgroundColor: theme.color.surfaceMuted,
  },
  modeActive: { backgroundColor: theme.color.surfaceRaised, borderColor: theme.color.borderStrong },
  modeText: { ...theme.type.label, color: theme.color.textMuted },
  modeTextActive: { color: theme.color.textPrimary },

  body: { padding: theme.space.lg, gap: theme.space.md, paddingBottom: theme.space.xxl },
  period: { ...theme.type.small, color: theme.color.textSecondary },

  heroRow: { flexDirection: "row", gap: theme.space.sm },
  hero: {
    flex: 1,
    backgroundColor: theme.color.surface,
    borderRadius: theme.radius.lg,
    borderWidth: 1,
    borderColor: theme.color.border,
    padding: theme.space.md,
    gap: 2,
  },
  heroLabel: { ...theme.type.caption, textTransform: "uppercase", color: theme.color.textMuted },
  // h1 rather than display: three of these sit side by side, and 34pt would wrap "$412.5k".
  heroValue: { ...theme.type.h1, color: theme.color.textPrimary, fontVariant: ["tabular-nums"] },
  heroCount: { ...theme.type.small, color: theme.color.textSecondary },
  basis: { ...theme.type.small, color: theme.color.textMuted },

  sectionLabel: { ...theme.type.caption, color: theme.color.textMuted, marginTop: theme.space.sm },
  card: {
    backgroundColor: theme.color.surface,
    borderRadius: theme.radius.lg,
    borderWidth: 1,
    borderColor: theme.color.border,
    padding: theme.space.lg,
    gap: theme.space.sm,
  },
  cardHead: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  cardLabel: { ...theme.type.caption, textTransform: "uppercase", color: theme.color.textMuted },
  chip: {
    ...theme.type.caption,
    color: theme.color.textSecondary,
    backgroundColor: theme.color.surfaceMuted,
    borderRadius: theme.radius.sm,
    paddingHorizontal: theme.space.sm,
    paddingVertical: 2,
    overflow: "hidden",
  },
  chipUp: { color: theme.color.greenText, backgroundColor: theme.color.greenSurface },
  chipDown: { color: theme.color.amberText, backgroundColor: theme.color.amberSurface },

  cardBody: { flexDirection: "row", alignItems: "baseline", gap: theme.space.md },
  cardCount: { ...theme.type.h2, color: theme.color.textPrimary, fontVariant: ["tabular-nums"] },
  cardValue: { ...theme.type.body, color: theme.color.textSecondary },

  spark: { flexDirection: "row", alignItems: "flex-end", gap: 3, height: 28 },
  sparkSlot: { flex: 1, height: "100%", justifyContent: "flex-end" },
  // A floor of 2pt so an empty week is still a mark on the axis rather than a gap that reads as
  // missing data.
  sparkBar: { minHeight: 2, borderRadius: 1, backgroundColor: theme.color.borderStrong },

  deferred: { ...theme.type.small, color: theme.color.textMuted },
  notes: { gap: theme.space.xs, marginTop: theme.space.sm },
  note: { ...theme.type.small, color: theme.color.textMuted },
});
