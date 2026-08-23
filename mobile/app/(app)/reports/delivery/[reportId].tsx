import React, { useCallback, useEffect, useRef, useState } from "react";
import { Alert, ScrollView, Share, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useQueryClient } from "@tanstack/react-query";
import { Ionicons } from "@expo/vector-icons";
import { theme } from "../../../../src/theme/theme";
import { useAuth } from "../../../../src/auth/AuthContext";
import {
  createWeeklyReportCorrection,
  getWeeklyReport,
  remintWeeklyReportShareLink,
  retryWeeklyReportSend,
} from "../../../../src/api/endpoints";
import type { WeeklyReportDetailView } from "../../../../src/api/types";
import {
  runWeeklyReportCorrection,
  runWeeklyReportRetry,
  weeklyReportCanCorrect,
  weeklyReportCanRetryDelivery,
  weeklyReportDeliveryDetail,
  weeklyReportDeliveryErrorMessage,
  weeklyReportDeliveryLabel,
  weeklyReportDeliveryState,
  weeklyReportRetryNeedsAcknowledgement,
} from "../../../../src/weekly-reports/delivery";
import { formatWeekOf } from "../../../../src/weekly-reports/status";
import { Button, EmptyState, LoadingState, SectionLabel } from "../../../../src/components/ui";
import { Banner } from "../../../../src/components/Banner";
import { ScreenHeader } from "../../../../src/components/ScreenHeader";

/**
 * What happened to the client's email — the screen the assigned PM never had.
 *
 * Reached from the hub's "Not delivered to the client" list, which exists because a `sent` week leaves the
 * PM's review queue: before this, a send that failed was visible only on the CRM board and in the sweep's
 * alert email, and the ordinary `construction` PM can reach neither. So the person who pressed Send was the
 * one person the platform never told.
 *
 * THE DECISIONS LIVE IN src/weekly-reports/delivery.ts, not in this component. `mobile/` is not compiled by
 * CI beyond a typecheck and the app has no OTA, so a rule that exists only inside a React component ships
 * to phones with nothing having executed it. What stays here is layout, the two dialogs, and the fetch.
 *
 * IT HOLDS A CLIENT LINK ONLY IN STATE, AND ONLY AFTER A DELIBERATE TAP. That changed with #17: the
 * re-mint button exists because the send screen shows the link once and only a SHA-256 hash is stored, so
 * a PM who left that screen previously had to ask a director for a link to their own report.
 *
 * The rule the screen kept is the one that matters, and it is about PERSISTENCE rather than possession:
 * the minted URL lives in component state that dies with the screen, this file imports no storage module
 * and makes no console call, and src/weekly-reports/__tests__/send.test.ts asserts both structurally by
 * parsing the AST rather than leaving them to review. `mobile/` is not in CI and the app has no OTA, so a
 * link written to the keychain or a crash breadcrumb would ship to phones and live there for days with
 * nothing able to revoke it.
 *
 * The retry response still carries the report and no URL, and a correction answers with a fresh unsent
 * version that has no link yet — the ONE way a link reaches this screen is the re-mint call.
 */
export default function WeeklyReportDeliveryScreen() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const { fetcher, user, activeOfficeId } = useAuth();
  const { reportId: rawReportId, projectName: rawProjectName } = useLocalSearchParams<{
    reportId: string;
    projectName?: string;
  }>();
  const reportId = typeof rawReportId === "string" ? rawReportId : "";
  const projectName = typeof rawProjectName === "string" ? rawProjectName : null;

  const [report, setReport] = useState<WeeklyReportDetailView | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [noticeTone, setNoticeTone] = useState<"error" | "success">("error");
  const [busy, setBusy] = useState<null | "retry" | "correction" | "remint">(null);
  // Held in state, never persisted and never logged: this is a live, login-free client credential.
  // Lost on navigation exactly as the send screen's is, which the copy beside it says plainly.
  const [mintedUrl, setMintedUrl] = useState<string | null>(null);

  // `busy` drives the spinners; this ref is what actually bars a second POST. React state does not update
  // before a second tap in the SAME native event batch re-reads it, and here the second tap is not a
  // harmless duplicate: past the provider's dedupe window an acknowledged retry is a real email, so two
  // taps are two copies in a client's inbox.
  const actionInFlight = useRef(false);

  const load = useCallback(async (): Promise<WeeklyReportDetailView | null> => {
    const { report: loaded } = await getWeeklyReport(fetcher, reportId);
    setReport(loaded);
    return loaded;
  }, [fetcher, reportId]);

  useEffect(() => {
    let cancelled = false;
    if (!reportId) {
      setLoadError("This report could not be identified.");
      return;
    }
    (async () => {
      try {
        const { report: loaded } = await getWeeklyReport(fetcher, reportId);
        if (!cancelled) setReport(loaded);
      } catch (error) {
        // The 403 carries the server's own sentence, which names the assigned PM — useful to a
        // superintendent who followed a link here, where a dead screen would not be.
        if (!cancelled) setLoadError(weeklyReportDeliveryErrorMessage(error));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [fetcher, reportId]);

  /**
   * A confirmation that resolves FALSE on every path except an explicit yes.
   *
   * `onDismiss` is the load-bearing option, not a nicety: Android's back gesture closes an alert without
   * firing any button, and without it the promise never settles — the screen would sit disabled forever,
   * and worse, a caller that treated a hung promise as consent would be reading silence as yes. What this
   * would consent to is a second email to a paying client.
   */
  function confirm(prompt: { title: string; message: string }): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      Alert.alert(
        prompt.title,
        prompt.message,
        [
          { text: "Cancel", style: "cancel", onPress: () => resolve(false) },
          { text: "Yes, continue", style: "destructive", onPress: () => resolve(true) },
        ],
        { cancelable: true, onDismiss: () => resolve(false) },
      );
    });
  }

  function refreshHub(): void {
    void queryClient.invalidateQueries({
      queryKey: ["weekly-report-assignments", user?.id ?? "anon", activeOfficeId ?? "none"],
    });
  }

  async function onRetry() {
    if (!report || actionInFlight.current) return;
    actionInFlight.current = true;
    setBusy("retry");
    setNotice(null);
    try {
      const outcome = await runWeeklyReportRetry(
        { sentAt: report.sentAt },
        {
          confirm,
          retry: async (acknowledgeDuplicateRisk) => {
            const response = await retryWeeklyReportSend(fetcher, reportId, acknowledgeDuplicateRisk);
            return response.report;
          },
          onRetried: (updated) => {
            setReport(updated);
            refreshHub();
          },
        },
      );
      if (outcome === "retried") {
        setNoticeTone("success");
        // Says what was actually achieved. The email has been QUEUED; nothing here can promise delivery,
        // and the row above will say so on the next read.
        setNotice("Queued again. Pull to refresh in a minute to see whether it got out.");
      }
    } catch (error) {
      setNoticeTone("error");
      setNotice(weeklyReportDeliveryErrorMessage(error));
      // The state may have moved under us — a director may have retried from the CRM, or the worker may
      // have delivered it between the read and the tap. Re-reading turns a stale screen into an accurate
      // one; failing to re-read is how a PM taps a button the server has already stopped honouring.
      try {
        await load();
      } catch {
        // Leave the screen as it was: the banner above already carries the actionable sentence.
      }
    } finally {
      actionInFlight.current = false;
      setBusy(null);
    }
  }

  async function onRemint() {
    if (!report || actionInFlight.current) return;
    actionInFlight.current = true;
    setBusy("remint");
    setNotice(null);
    try {
      const { url } = await remintWeeklyReportShareLink(fetcher, reportId);
      setMintedUrl(url);
      setNoticeTone("success");
      setNotice("New link created. It is shown once — copy it before leaving this screen.");
    } catch (error) {
      setNoticeTone("error");
      setNotice(weeklyReportDeliveryErrorMessage(error));
    } finally {
      actionInFlight.current = false;
      setBusy(null);
    }
  }

  async function shareMinted() {
    if (!mintedUrl) return;
    try {
      await Share.share({ message: mintedUrl, url: mintedUrl });
    } catch {
      // The sheet failed to present. The URL is on screen and selectable, which is the fallback.
    }
  }

  async function onCorrection() {
    if (!report || actionInFlight.current) return;
    actionInFlight.current = true;
    setBusy("correction");
    setNotice(null);
    try {
      await runWeeklyReportCorrection(
        { delivered: Boolean(report.sendDeliveredAt) },
        {
          confirm,
          create: async () => {
            const response = await createWeeklyReportCorrection(fetcher, reportId);
            return response.report;
          },
          onCreated: (correction) => {
            refreshHub();
            // Straight into the send flow on the new version. A correction nobody sends is just a second
            // draft, and the original keeps standing as the week's live report — which is the failure mode
            // that makes a correction the wrong first move on a failed delivery in the first place.
            router.replace({
              pathname: "/(app)/reports/send/[reportId]",
              params: { reportId: correction.id, projectName: projectName ?? "" },
            });
          },
        },
      );
    } catch (error) {
      setNoticeTone("error");
      setNotice(weeklyReportDeliveryErrorMessage(error));
    } finally {
      actionInFlight.current = false;
      setBusy(null);
    }
  }

  if (loadError) {
    return (
      <SafeAreaView style={styles.screen} edges={["top"]}>
        <ScreenHeader onBack={() => router.back()} title="Delivery" />
        <View style={styles.body}>
          <EmptyState title="Can’t open this report" subtitle={loadError} />
        </View>
      </SafeAreaView>
    );
  }

  if (!report) {
    return (
      <SafeAreaView style={styles.screen} edges={["top"]}>
        <ScreenHeader onBack={() => router.back()} title="Delivery" />
        <View style={styles.body}>
          <LoadingState label="Checking the delivery…" />
        </View>
      </SafeAreaView>
    );
  }

  const state = weeklyReportDeliveryState(report);
  const canRetry = weeklyReportCanRetryDelivery(report);
  const canCorrect = weeklyReportCanCorrect(report);
  const tone =
    state === "delivered"
      ? theme.color.success
      : state === "sending"
        ? theme.color.textMuted
        : theme.color.danger;
  const icon =
    state === "delivered" ? "checkmark-circle" : state === "sending" ? "time-outline" : "alert-circle";

  return (
    <SafeAreaView style={styles.screen} edges={["top", "bottom"]}>
      <ScreenHeader onBack={() => router.back()} title="Delivery" />
      {/* Pinned above the scroll, like the send screen's. This screen's buttons sit below a block of
          explanatory text, so a banner rendered inline would not be on the same screen as the control that
          produced it — and a PM who sees no response to a tap taps again. */}
      {notice ? (
        <View style={styles.noticeWrap}>
          <Banner message={notice} tone={noticeTone === "success" ? "success" : "error"} />
        </View>
      ) : null}
      <ScrollView contentContainerStyle={styles.body}>
        <Text style={styles.subhead}>
          {projectName ?? "Weekly report"} · week of {formatWeekOf(report.weekOf)}
          {report.version > 1 ? ` · v${report.version}` : ""}
        </Text>

        <View style={styles.stateHead}>
          <Ionicons name={icon} size={26} color={tone} />
          <Text style={[styles.stateTitle, { color: tone }]}>{weeklyReportDeliveryLabel(state)}</Text>
        </View>
        <Text style={styles.paragraph}>{weeklyReportDeliveryDetail(report, state)}</Text>

        {/* Shown BEFORE the button, not in the dialog alone. A PM who knows what the confirmation will say
            can decide whether to open it at all, and the sentence is the reason this screen refuses to
            make Retry a one-tap action past the window. */}
        {canRetry && weeklyReportRetryNeedsAcknowledgement(report.sentAt) ? (
          <Text style={styles.warning}>
            This send is more than a day old, so a retry is a genuinely new email rather than a repeat the
            mail provider will ignore. If the first one did go out, the client gets a second copy.
          </Text>
        ) : null}

        {canRetry ? (
          <>
            <SectionLabel>Send it again</SectionLabel>
            <Text style={styles.hint}>
              Queues the same email, to the same people, with the same link. Nothing about the report
              changes and the client is told nothing new.
            </Text>
            <Button
              title="Retry delivery"
              onPress={() => void onRetry()}
              loading={busy === "retry"}
              disabled={busy !== null}
              accessibilityLabel="Retry sending this report to the client"
            />
          </>
        ) : null}

        {canCorrect ? (
          <>
            <SectionLabel>Something in the report is wrong</SectionLabel>
            {/* The copy the send screen used to hand a PM instead of a capability. A sent report is
                immutable for everyone, leadership included, so a correction is the only way to change what
                the client is looking at — and it is a NEW version they are told about, not an edit. */}
            <Text style={styles.hint}>
              A sent report can’t be edited. Issuing a correction starts version {report.version + 1} as a
              copy of this one, which you then send — the client is told it replaces what they have.
              {canRetry ? " If the email simply never arrived, use Retry above instead." : ""}
            </Text>
            <Button
              title="Issue a correction"
              variant="ghost"
              onPress={() => void onCorrection()}
              loading={busy === "correction"}
              disabled={busy !== null}
              accessibilityLabel={`Issue a correction, starting version ${report.version + 1} of this report`}
            />
          </>
        ) : null}

        {/* #17. The send screen shows the client link ONCE and says so; only a SHA-256 hash is stored, so
            nothing can hand the original back. Before this, a PM who left that screen had to ask a
            director for a link to a report they wrote and sent themselves — the one re-mint route lived
            on the CRM router, which a `construction` account cannot reach.

            Offered on any shareable version, not only an undelivered one: "the client says they lost the
            email" has nothing to do with whether delivery succeeded. */}
        <SectionLabel>The client needs the link again</SectionLabel>
        <Text style={styles.hint}>
          Creates a NEW link to this report. The one already emailed keeps working — a fresh link is not a
          replacement, so nothing the client already has stops opening.
        </Text>
        <Button
          title="Create a new link"
          variant="ghost"
          onPress={() => void onRemint()}
          loading={busy === "remint"}
          disabled={busy !== null}
          accessibilityLabel="Create a new client link for this report"
        />
        {mintedUrl ? (
          <>
            {/* SHOWN ONCE HERE TOO, and the copy says so, because leaving this screen loses it exactly as
                it does on the send screen. */}
            <Text style={styles.warning}>
              This is the only time this link is shown. It opens the report without a login for 180 days.
            </Text>
            <Text selectable style={styles.url}>
              {mintedUrl}
            </Text>
            <Button title="Share link" variant="ghost" onPress={() => void shareMinted()} />
          </>
        ) : null}

        {!canRetry && !canCorrect ? (
          // Reachable when a newer version has already been sent: this row is superseded, so neither
          // action belongs on it. Says where the work went rather than showing two disabled buttons.
          <Text style={styles.hint}>
            A newer version of this week has already gone to the client, so there is nothing left to do on
            this one. Any further fix belongs on that version.
          </Text>
        ) : null}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: theme.color.surfaceApp },
  body: { padding: theme.space.lg, gap: theme.space.sm, paddingBottom: theme.space.xxl },
  noticeWrap: { paddingHorizontal: theme.space.lg, paddingTop: theme.space.sm },
  subhead: { fontFamily: theme.font.medium, fontSize: 14, color: theme.color.textMuted },
  stateHead: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.space.sm,
    marginTop: theme.space.sm,
  },
  stateTitle: { fontFamily: theme.font.semibold, fontSize: 18 },
  paragraph: { fontFamily: theme.font.body, fontSize: 14, color: theme.color.textPrimary },
  hint: { fontFamily: theme.font.body, fontSize: 12.5, color: theme.color.textMuted },
  // Mirrors the send screen's, so a client link looks the same wherever it is shown once.
  url: {
    fontFamily: theme.font.body,
    fontSize: 13,
    color: theme.color.textPrimary,
    backgroundColor: theme.color.surfaceMuted,
    borderRadius: theme.radius.md,
    padding: theme.space.md,
  },
  warning: { fontFamily: theme.font.medium, fontSize: 13, color: theme.color.warning },
});
