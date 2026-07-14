import React, { useCallback, useState } from "react";
import { Linking, RefreshControl, ScrollView, StyleSheet } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useFocusEffect, useLocalSearchParams, useRouter } from "expo-router";
import { theme } from "../../../../src/theme/theme";
import { useAuth } from "../../../../src/auth/AuthContext";
import { useScorecard } from "../../../../src/query/hooks";
import { getScorecardDownload } from "../../../../src/api/endpoints";
import { scorecardDetailHeaderTitle, scorecardDownloadErrorMessage } from "../../../../src/scorecards/detail-view";
import { EmptyState, LoadingState } from "../../../../src/components/ui";
import { Banner } from "../../../../src/components/Banner";
import { ScreenHeader } from "../../../../src/components/ScreenHeader";
import { ScorecardDetailView } from "../../../../src/components/ScorecardDetailView";
import type { FieldScorecardPhotoView } from "../../../../src/api/types";

function toStr(v: string | string[] | undefined): string {
  return Array.isArray(v) ? v[0] ?? "" : v ?? "";
}

export default function ScorecardDetailScreen() {
  const router = useRouter();
  const id = toStr(useLocalSearchParams<{ id: string }>().id);
  const { fetcher } = useAuth();
  const query = useScorecard(id);
  const [downloading, setDownloading] = useState(false);
  const [notice, setNotice] = useState<{ message: string; tone: "error" | "success" } | null>(null);

  // Presigned photo/PDF URLs are ~60 min. refetchOnWindowFocus is a NO-OP in RN (no focusManager/AppState
  // wiring in this app), so refetch explicitly on focus — matches scorecards/index.tsx + projects/[id].tsx.
  useFocusEffect(
    useCallback(() => {
      void query.refetch();
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [id]),
  );

  async function downloadPdf() {
    setNotice(null); // clear any prior error so a later success doesn't leave a stale red banner
    setDownloading(true);
    try {
      const { url } = await getScorecardDownload(fetcher, id);
      await Linking.openURL(url);
    } catch (err) {
      // The /download 404 has three server causes (pdf still generating / row gone / deal went terminal);
      // scorecardDownloadErrorMessage echoes the server's own text when present, else falls back by status.
      setNotice({ message: scorecardDownloadErrorMessage(err), tone: "error" });
    } finally {
      setDownloading(false);
    }
  }

  async function openPhoto(photo: FieldScorecardPhotoView) {
    // v1: open the presigned evidence photo in the system browser (Design decision #5). No-op if null.
    if (!photo.url) return;
    setNotice(null); // clear any prior error so a successful open doesn't leave a stale banner
    try {
      await Linking.openURL(photo.url);
    } catch {
      setNotice({ message: "Couldn't open that photo.", tone: "error" });
    }
  }

  const scorecard = query.data?.scorecard;
  const errorStatus = (query.error as { status?: number } | null | undefined)?.status;
  // The detail endpoint THROWS 404 when the scorecard row is gone OR its project went terminal
  // (assertActiveFieldProject) — that is the genuinely-absent case → EmptyState. Any OTHER failure
  // (offline, 5xx, transient) is a load error the user should be able to retry, not "removed".
  const isMissing = query.isError && errorStatus === 404;
  const isLoadError = query.isError && !isMissing;
  const headerTitle = scorecardDetailHeaderTitle(scorecard);

  return (
    <SafeAreaView style={styles.safe} edges={["top"]}>
      <ScreenHeader onBack={() => router.back()} title={headerTitle} />
      <ScrollView
        contentContainerStyle={styles.body}
        refreshControl={
          <RefreshControl
            refreshing={query.isRefetching}
            onRefresh={() => void query.refetch()}
            tintColor={theme.color.brandRed}
          />
        }
      >
        {notice ? <Banner message={notice.message} tone={notice.tone} /> : null}
        {query.isLoading ? (
          <LoadingState label="Loading scorecard…" />
        ) : isLoadError ? (
          <Banner
            tone="error"
            message="Couldn't load this scorecard."
            action={{ label: "Retry", onPress: () => void query.refetch() }}
          />
        ) : !scorecard ? (
          <EmptyState
            title="Scorecard unavailable"
            subtitle="It may have been removed, or its project is no longer active."
          />
        ) : (
          <ScorecardDetailView
            scorecard={scorecard}
            onDownloadPdf={downloadPdf}
            downloadingPdf={downloading}
            onOpenPhoto={openPhoto}
          />
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: theme.color.surfaceApp },
  body: { padding: theme.space.lg, gap: theme.space.lg, paddingBottom: theme.space.xxl },
});
