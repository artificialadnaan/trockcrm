import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  Share,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useQueryClient } from "@tanstack/react-query";
import { Ionicons } from "@expo/vector-icons";
import { theme } from "../../../../src/theme/theme";
import { useAuth } from "../../../../src/auth/AuthContext";
import { getWeeklyReportSendDraft, sendWeeklyReport } from "../../../../src/api/endpoints";
import type { WeeklyReportSendDraftView } from "../../../../src/api/types";
import {
  WEEKLY_REPORT_SEND_LIMITS,
  runWeeklyReportSend,
  weeklyReportSendErrorMessage,
  weeklyReportSendPreviewNote,
  weeklyReportSendRecipients,
  weeklyReportSendVersionNote,
} from "../../../../src/weekly-reports/send";
import { formatWeekOf } from "../../../../src/weekly-reports/status";
import { Button, EmptyState, LoadingState, SectionLabel, TextInput } from "../../../../src/components/ui";
import { Banner } from "../../../../src/components/Banner";
import { ScreenHeader } from "../../../../src/components/ScreenHeader";

/**
 * Sending the weekly report to the client — the assigned PM's last step, on the surface they work from.
 *
 * WHAT THIS SCREEN RENDERS IS NOT WHAT IT COMPOSES. The subject, the greeting, the default message and the
 * body preview all arrive from GET /field/weekly-reports/reports/:id/send-draft, composed by the same
 * service the CRM's dialog reads. The PM edits three values and posts them back. Nothing about the email's
 * wording is decided here, which is the only reason "the modal is identical on both surfaces" is a fact
 * rather than a promise two clients keep.
 *
 * THE DECISIONS LIVE IN src/weekly-reports/send.ts, not in this component. `mobile/` is not in CI and the
 * app has no OTA, so a branch that exists only inside a React component ships to phones with nothing
 * having executed it — the reason door.ts and submit.ts were lifted out of the two screens beside this
 * one. What stays here is layout, keyboard handling and the two pieces of local state.
 *
 * THE SHARE LINK IS SHOWN ONCE AND STORED NOWHERE. `POST /send` answers with the only copy of the raw
 * token that will ever exist: public.weekly_report_tokens keeps a SHA-256 hash, no later read returns it,
 * and the send draft deliberately does not carry it. So it lives in `sent` — component state that dies
 * with the screen — and is never written to the draft store, a log line, a query cache or a navigation
 * param. This file imports no storage module and makes no console call, which is asserted by
 * src/weekly-reports/__tests__/send.test.ts rather than left to review.
 */
export default function WeeklyReportSendScreen() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const { fetcher, user, activeOfficeId } = useAuth();
  const { reportId: rawReportId, projectName: rawProjectName } = useLocalSearchParams<{
    reportId: string;
    projectName?: string;
  }>();
  const reportId = typeof rawReportId === "string" ? rawReportId : "";
  const projectName = typeof rawProjectName === "string" ? rawProjectName : null;

  const [draft, setDraft] = useState<WeeklyReportSendDraftView | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [recipients, setRecipients] = useState<string[]>([]);
  const [pendingRecipient, setPendingRecipient] = useState("");
  const [subject, setSubject] = useState("");
  const [message, setMessage] = useState("");
  const [attachPdf, setAttachPdf] = useState(true);
  const [notice, setNotice] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  /** The one-time client link, held only for as long as this screen is on screen. */
  const [sent, setSent] = useState<{ shareUrl: string } | null>(null);

  // `sending` drives the spinner; this ref is what actually bars a second POST. React state does not
  // update before a second tap in the SAME native event batch re-reads it, and the second send is not a
  // harmless duplicate: it answers 409 "already sent", which reads to the PM as though the first failed.
  const sendInFlight = useRef(false);

  useEffect(() => {
    let cancelled = false;
    if (!reportId) {
      setLoadError("This report could not be identified.");
      return;
    }
    (async () => {
      try {
        const { draft: loaded } = await getWeeklyReportSendDraft(fetcher, reportId);
        if (cancelled) return;
        setDraft(loaded);
        setRecipients(loaded.recipients);
        setSubject(loaded.subject);
        setMessage(loaded.contextParagraph);
        setAttachPdf(loaded.attachPdf);
      } catch (error) {
        // The 403 here is the useful one and it carries the server's own sentence: a superintendent who
        // reached this screen is told the assigned PM sends the report, rather than seeing a dead form.
        if (!cancelled) setLoadError(weeklyReportSendErrorMessage(error));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [fetcher, reportId]);

  const previewNote = useMemo(
    () => (draft ? weeklyReportSendPreviewNote(draft, recipients) : null),
    [draft, recipients],
  );
  const versionNote = draft ? weeklyReportSendVersionNote(draft) : null;

  function roleFor(email: string): string | null {
    const option = draft?.recipientOptions.find(
      (entry) => entry.email.toLowerCase() === email.toLowerCase(),
    );
    return option ? option.role : null;
  }

  /** Options the PM removed and can put back without retyping a client's address. */
  const removedOptions = (draft?.recipientOptions ?? []).filter(
    (option) => !recipients.some((entry) => entry.toLowerCase() === option.email.toLowerCase()),
  );

  function addPending(): boolean {
    const resolved = weeklyReportSendRecipients({ selected: recipients, pending: pendingRecipient });
    if (resolved.error) {
      setNotice(resolved.error);
      return false;
    }
    setRecipients(resolved.recipients);
    setPendingRecipient("");
    return true;
  }

  async function onSend() {
    if (!draft || sendInFlight.current) return;
    // A TYPED-BUT-NOT-ADDED ADDRESS COUNTS. The keyboard covers the Add button, so typing the client's new
    // contact and tapping Send is the natural gesture — and posting `recipients` alone would drop it
    // silently, so the person the PM had just added never receives the report and the request succeeds.
    const resolved = weeklyReportSendRecipients({ selected: recipients, pending: pendingRecipient });
    if (resolved.error) {
      setNotice(resolved.error);
      return;
    }
    setRecipients(resolved.recipients);
    setPendingRecipient("");

    sendInFlight.current = true;
    setSending(true);
    setNotice(null);
    try {
      await runWeeklyReportSend(
        {
          recipients: resolved.recipients,
          subject,
          contextParagraph: message,
          attachPdf,
        },
        {
          send: async (payload) => {
            const response = await sendWeeklyReport(fetcher, reportId, payload);
            return { report: response.report, shareUrl: response.shareUrl };
          },
          // The ONLY thing handed the raw link. It goes into component state and nowhere else.
          reveal: (outcome) => setSent({ shareUrl: outcome.shareUrl }),
          // Deliberately takes the REPORT and not the outcome: the refresh path must not be able to carry
          // a live client credential into a query cache.
          recordSent: () => {
            void queryClient.invalidateQueries({
              queryKey: ["weekly-report-assignments", user?.id ?? "anon", activeOfficeId ?? "none"],
            });
          },
        },
      );
    } catch (error) {
      setNotice(weeklyReportSendErrorMessage(error));
    } finally {
      sendInFlight.current = false;
      setSending(false);
    }
  }

  async function shareLink() {
    if (!sent) return;
    try {
      await Share.share({ message: sent.shareUrl, url: sent.shareUrl });
    } catch {
      // The sheet failed to present. The URL is still on screen and selectable, which is the fallback.
    }
  }

  const heading = draft?.isCorrection ? "Send correction" : "Send to client";

  if (loadError) {
    return (
      <SafeAreaView style={styles.screen} edges={["top"]}>
        <ScreenHeader onBack={() => router.back()} title={heading} />
        <View style={styles.body}>
          <EmptyState title="Can’t send this report" subtitle={loadError} />
        </View>
      </SafeAreaView>
    );
  }

  if (!draft) {
    return (
      <SafeAreaView style={styles.screen} edges={["top"]}>
        <ScreenHeader onBack={() => router.back()} title={heading} />
        <View style={styles.body}>
          <LoadingState label="Preparing the email…" />
        </View>
      </SafeAreaView>
    );
  }

  if (sent) {
    return (
      <SafeAreaView style={styles.screen} edges={["top", "bottom"]}>
        {/* Still offers Back. Leaving loses the link, which is why the copy below says so plainly — but
            withholding the chevron would not prevent it (the stack's swipe-back is always there) and would
            only leave the title unrendered, since ScreenHeader shows one only alongside a back control. */}
        <ScreenHeader onBack={() => router.back()} title="Report sent" />
        <ScrollView contentContainerStyle={styles.body}>
          <View style={styles.sentHead}>
            <Ionicons name="checkmark-circle" size={28} color={theme.color.success} />
            <Text style={styles.sentTitle}>The client’s email is on its way</Text>
          </View>
          <Text style={styles.paragraph}>
            {draft.propertyName ?? projectName ?? "This report"} · week of {formatWeekOf(draft.weekOf)}, sent
            to {recipients.length} {recipients.length === 1 ? "person" : "people"}.
          </Text>

          <SectionLabel>The client’s link</SectionLabel>
          {/* SHOWN ONCE, and the copy says so plainly rather than implying it can be found again later.
              public.weekly_report_tokens keeps only a SHA-256 hash and no API read hands the raw value
              back — the send draft deliberately does not carry it. (The worker holds it in
              `send_request.shareUrl` until it has delivered the email, which is how the message gets
              composed after a restart; it is dropped on delivery and was never reachable from here.)
              Re-minting is `POST /reports/:id/share-link`, which is on the CRM router behind its
              admin/director/rep gate, so a construction PM cannot do it — leadership can. */}
          <Text style={styles.warning}>
            This is the only time this link is shown. It opens the report without a login for 180 days.
          </Text>
          <Text selectable style={styles.url}>
            {sent.shareUrl}
          </Text>
          <Button title="Share link" variant="ghost" onPress={() => void shareLink()} />
          <Text style={styles.hint}>
            The client does not need it — it is already in the email. Share it only if somebody asks for it
            directly.
          </Text>

          <Button title="Done" onPress={() => router.back()} style={{ marginTop: theme.space.md }} />
        </ScrollView>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.screen} edges={["top", "bottom"]}>
      <ScreenHeader onBack={() => router.back()} title={heading} />
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
        keyboardVerticalOffset={8}
      >
        {/* OUTSIDE the ScrollView, like the sibling wizard's noticeWrap. `notice` is this screen's only
            error channel, and the Send button sits at the very bottom of a scroll that holds the whole
            recipient list, subject, message body and preview — so a banner rendered inline was never on
            the same screen as the button that triggers it. The PM taps Send, gets a 409 because a
            director sent it from the CRM thirty seconds earlier, and from where they are looking nothing
            happened, so they tap again. That includes the offline copy, which exists precisely to stop a
            second tap. */}
        {notice ? (
          <View style={styles.noticeWrap}>
            <Banner message={notice} />
          </View>
        ) : null}
        <ScrollView contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled">
          <Text style={styles.subhead}>
            {draft.propertyName ?? projectName ?? "Weekly report"} · week of {formatWeekOf(draft.weekOf)}
          </Text>
          {/* Informational, not a failure: a correction is an ordinary act, so it stays inline with the
              content it describes and keeps the info tone. The error banner above is pinned. */}
          {versionNote ? <Banner message={versionNote} tone="info" /> : null}

          <SectionLabel>To</SectionLabel>
          {recipients.length === 0 ? (
            <Text style={styles.hint}>No recipients yet — add at least one client address.</Text>
          ) : null}
          {recipients.map((email) => (
            <View key={email} style={styles.row}>
              <View style={{ flex: 1 }}>
                <Text style={styles.rowText} numberOfLines={1}>
                  {email}
                </Text>
                {roleFor(email) ? <Text style={styles.rowRole}>{roleFor(email)}</Text> : null}
              </View>
              <Pressable
                onPress={() => setRecipients((prev) => prev.filter((entry) => entry !== email))}
                hitSlop={10}
                accessibilityRole="button"
                accessibilityLabel={`Remove ${email}`}
              >
                <Ionicons name="close" size={20} color={theme.color.textMuted} />
              </Pressable>
            </View>
          ))}

          {removedOptions.length > 0 ? (
            <View style={styles.chipRow}>
              {removedOptions.map((option) => (
                <Pressable
                  key={option.email}
                  onPress={() => setRecipients((prev) => [...prev, option.email])}
                  style={styles.chip}
                  accessibilityRole="button"
                  accessibilityLabel={`Add ${option.name ?? option.email} back to the recipients`}
                >
                  <Ionicons name="add" size={14} color={theme.color.textMuted} />
                  <Text style={styles.chipText}>{option.name ?? option.email}</Text>
                </Pressable>
              ))}
            </View>
          ) : null}

          <View style={styles.addRow}>
            <TextInput
              value={pendingRecipient}
              onChangeText={setPendingRecipient}
              onBlur={() => {
                if (pendingRecipient.trim()) addPending();
              }}
              onSubmitEditing={() => addPending()}
              placeholder="Add another address"
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="email-address"
              returnKeyType="done"
              style={{ flex: 1 }}
              accessibilityLabel="Add another recipient address"
            />
            <Button title="Add" variant="ghost" onPress={() => addPending()} />
          </View>

          <SectionLabel>Subject</SectionLabel>
          <TextInput
            value={subject}
            onChangeText={setSubject}
            maxLength={WEEKLY_REPORT_SEND_LIMITS.maxSubjectChars}
            accessibilityLabel="Email subject"
          />

          <SectionLabel>Message</SectionLabel>
          <TextInput
            value={message}
            onChangeText={setMessage}
            multiline
            maxLength={WEEKLY_REPORT_SEND_LIMITS.maxContextChars}
            style={styles.messageInput}
            accessibilityLabel="Message to the client"
          />

          <Pressable
            onPress={() => setAttachPdf((prev) => !prev)}
            style={styles.row}
            accessibilityRole="checkbox"
            accessibilityState={{ checked: attachPdf }}
            accessibilityLabel="Attach the report PDF"
          >
            <Ionicons
              name={attachPdf ? "checkbox" : "square-outline"}
              size={22}
              color={attachPdf ? theme.color.brandRed : theme.color.textMuted}
            />
            <Text style={[styles.rowText, { flex: 1 }]}>Attach the report as a PDF</Text>
          </Pressable>

          <SectionLabel>What the client receives</SectionLabel>
          {previewNote ? <Text style={styles.hint}>{previewNote}</Text> : null}
          <Text style={styles.preview}>{draft.bodyPreview}</Text>

          <Button
            title={draft.isCorrection ? "Send correction" : "Send to client"}
            onPress={() => void onSend()}
            loading={sending}
            disabled={sending}
            style={{ marginTop: theme.space.md }}
          />
          {/* Stated before the tap, not after it. The transition is terminal: the only way to change a
              sent report is a correction, which is a new version the client is told about. */}
          {/* Says who can do it, not just that it is possible. The correction and retry ROUTES exist on
              this mount, but no screen calls them yet: a sent week leaves the PM's queue, so T-Rock Cam
              shows nothing afterwards. Promising "issue a correction" to a `construction` PM who has no
              control here, and whom the CRM also refuses, is a promise the product does not keep. */}
          <Text style={styles.hint}>
            Once this goes out the report is final. A mistake has to be fixed by issuing a correction —
            ask an admin or director, since that is not yet something you can do in the app.
          </Text>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: theme.color.surfaceApp },
  body: { padding: theme.space.lg, gap: theme.space.sm, paddingBottom: theme.space.xxl },
  // Same shape as the wizard's, so the two screens' error banners sit identically.
  noticeWrap: { paddingHorizontal: theme.space.lg, paddingTop: theme.space.sm },
  subhead: {
    fontFamily: theme.font.medium,
    fontSize: 14,
    color: theme.color.textMuted,
  },
  paragraph: { fontFamily: theme.font.body, fontSize: 14, color: theme.color.textPrimary },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.space.sm,
    backgroundColor: theme.color.surfaceCard,
    borderColor: theme.color.border,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: theme.radius.md,
    paddingHorizontal: theme.space.md,
    paddingVertical: theme.space.sm,
  },
  rowText: { fontFamily: theme.font.body, fontSize: 15, color: theme.color.textPrimary },
  rowRole: {
    fontFamily: theme.font.semibold,
    fontSize: 11,
    letterSpacing: 0.6,
    color: theme.color.textMuted,
  },
  chipRow: { flexDirection: "row", flexWrap: "wrap", gap: theme.space.xs },
  chip: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.space.xs,
    borderColor: theme.color.border,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: theme.radius.pill,
    paddingHorizontal: theme.space.md,
    paddingVertical: theme.space.xs,
  },
  chipText: { fontFamily: theme.font.medium, fontSize: 13, color: theme.color.textMuted },
  addRow: { flexDirection: "row", alignItems: "center", gap: theme.space.sm },
  messageInput: { minHeight: 120, textAlignVertical: "top" },
  preview: {
    fontFamily: theme.font.body,
    fontSize: 13,
    lineHeight: 19,
    color: theme.color.textMuted,
    backgroundColor: theme.color.surfaceMuted,
    borderRadius: theme.radius.md,
    padding: theme.space.md,
  },
  hint: { fontFamily: theme.font.body, fontSize: 12.5, color: theme.color.textMuted },
  warning: { fontFamily: theme.font.medium, fontSize: 13, color: theme.color.warning },
  url: {
    fontFamily: theme.font.body,
    fontSize: 13,
    color: theme.color.textPrimary,
    backgroundColor: theme.color.surfaceMuted,
    borderRadius: theme.radius.md,
    padding: theme.space.md,
  },
  sentHead: { flexDirection: "row", alignItems: "center", gap: theme.space.sm },
  sentTitle: { fontFamily: theme.font.semibold, fontSize: 17, color: theme.color.textPrimary },
});
