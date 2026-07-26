import React, { useState } from "react";
import {
  ActivityIndicator,
  Linking,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { SafeAreaView } from "react-native-safe-area-context";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ApiError } from "../../../src/api/client";
import * as dealsApi from "../../../src/api/endpoints/deals";
import { useAuth } from "../../../src/auth/AuthContext";
import { useQueryScope } from "../../../src/auth/useOfficeId";
import { displayAmount, showsAtRisk } from "../../../src/components/DealCard";
import { daysSince, formatDate, formatLocation } from "../../../src/format";
import { qk } from "../../../src/query/keys";
import { theme } from "../../../src/theme/theme";

export default function DealDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const dealId = typeof id === "string" ? id : "";
  const router = useRouter();
  const { fetcher } = useAuth();
  const scope = useQueryScope();
  const queryClient = useQueryClient();
  const [note, setNote] = useState("");

  const dealQuery = useQuery({
    queryKey: qk.deal(scope, dealId),
    queryFn: () => dealsApi.getDealDetail(fetcher, dealId),
    enabled: dealId.length > 0,
  });

  const activitiesQuery = useQuery({
    queryKey: qk.dealActivities(scope, dealId),
    queryFn: () => dealsApi.listActivities(fetcher, dealId),
    enabled: dealId.length > 0,
  });

  const logNote = useMutation({
    mutationFn: (notes: string) =>
      dealsApi.createActivity(fetcher, { dealId, type: "note", body: notes }),
    onSuccess: async (_result, submitted) => {
      // Clear ONLY what was actually sent. A rep can keep typing while a slow save is in flight, and
      // blanking the field unconditionally would silently delete everything written after the request
      // began — losing exactly the observation they opened the app to record.
      setNote((current) => (current === submitted ? "" : current));
      await queryClient.invalidateQueries({ queryKey: qk.dealActivities(scope, dealId) });
    },
  });

  const watch = useMutation({
    mutationFn: (next: boolean) =>
      next ? dealsApi.watchDeal(fetcher, dealId) : dealsApi.unwatchDeal(fetcher, dealId),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: qk.deal(scope, dealId) });
      // The Watched list is derived from this flag, so it must be invalidated too — otherwise an
      // already-mounted list keeps showing an unwatched deal (or hiding a newly watched one).
      await queryClient.invalidateQueries({ queryKey: ["deals"] });
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

  if (dealQuery.error || !dealQuery.data) {
    const offline = dealQuery.error instanceof ApiError && dealQuery.error.status === 0;
    return (
      <SafeAreaView style={styles.safe}>
        <View style={styles.center}>
          <Text style={styles.errorTitle}>{offline ? "You're offline" : "Couldn't load this deal"}</Text>
          <Pressable onPress={() => router.back()} accessibilityRole="button" style={styles.backBtn}>
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

  return (
    <SafeAreaView style={styles.safe} edges={["top"]}>
      <ScrollView contentContainerStyle={styles.body}>
        <Pressable onPress={() => router.back()} accessibilityRole="button" accessibilityLabel="Back">
          <Text style={styles.back}>‹ Deals</Text>
        </Pressable>

        <Text style={styles.name}>{deal.name ?? "Untitled deal"}</Text>
        {deal.companyName ? <Text style={styles.company}>{deal.companyName}</Text> : null}

        <View style={styles.badgeRow}>
          <Text style={styles.amount}>{displayAmount(deal)}</Text>
          {deal.onHold ? <Badge label="On hold" tone="amber" /> : null}
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

        <Section title="Details">
          <Row label="Stage" value={deal.stageSlug ?? "—"} />
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
            {deal.primaryContactPhone ? (
              <ContactAction
                testID="call-contact"
                label="Call"
                value={deal.primaryContactPhone}
                url={`tel:${deal.primaryContactPhone.replace(/[^\d+]/g, "")}`}
              />
            ) : null}
            {deal.primaryContactEmail ? (
              <ContactAction
                testID="email-contact"
                label="Email"
                value={deal.primaryContactEmail}
                url={`mailto:${deal.primaryContactEmail}`}
              />
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
          {activitiesQuery.isLoading ? (
            <ActivityIndicator color={theme.color.brandRed} />
          ) : activitiesQuery.error ? (
            // A failed timeline request is NOT an empty timeline. Claiming "nothing logged" on a 5xx
            // presents a failure as authoritative CRM data, and a rep would believe it.
            <Pressable
              testID="retry-activities"
              onPress={() => void activitiesQuery.refetch()}
              accessibilityRole="button"
              style={styles.retry}
            >
              <Text style={styles.retryText}>Couldn&apos;t load activity — tap to retry</Text>
            </Pressable>
          ) : (activitiesQuery.data ?? []).length === 0 ? (
            <Text style={styles.emptyActivity}>Nothing logged yet.</Text>
          ) : (
            (activitiesQuery.data ?? []).map((a) => (
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

function Row({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.row}>
      <Text style={styles.rowLabel}>{label}</Text>
      <Text style={styles.rowValue}>{value}</Text>
    </View>
  );
}

function ContactAction({
  testID,
  label,
  value,
  url,
}: {
  testID: string;
  label: string;
  value: string;
  url: string;
}) {
  return (
    <Pressable
      testID={testID}
      onPress={() => void Linking.openURL(url).catch(() => undefined)}
      accessibilityRole="button"
      accessibilityLabel={`${label} ${value}`}
      style={styles.row}
    >
      <Text style={styles.rowLabel}>{label}</Text>
      <Text style={[styles.rowValue, styles.link]}>{value}</Text>
    </Pressable>
  );
}

function Badge({ label, tone }: { label: string; tone: "amber" | "red" }) {
  return (
    <View style={[styles.badge, tone === "amber" ? styles.badgeAmber : styles.badgeRed]}>
      <Text style={[styles.badgeText, tone === "amber" ? styles.badgeTextAmber : styles.badgeTextRed]}>
        {label}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: theme.color.surfaceMuted },
  body: { padding: theme.space.lg, gap: theme.space.sm, paddingBottom: theme.space.xxl },
  center: { flex: 1, alignItems: "center", justifyContent: "center", gap: theme.space.md },
  back: { fontFamily: theme.font.semibold, fontSize: 15, color: theme.color.brandRed },
  name: { fontFamily: theme.font.bold, fontSize: 24, color: theme.color.inkNavy, marginTop: theme.space.sm },
  company: { fontFamily: theme.font.semibold, fontSize: 15, color: theme.color.textSecondary },
  badgeRow: { flexDirection: "row", alignItems: "center", gap: theme.space.sm, marginTop: theme.space.xs },
  amount: { fontFamily: theme.font.bold, fontSize: 20, color: theme.color.textPrimary },
  badge: { borderRadius: theme.radius.pill, paddingHorizontal: theme.space.md, paddingVertical: 3 },
  badgeAmber: { backgroundColor: "#FEF3C7" },
  badgeRed: { backgroundColor: "#FEE2E2" },
  badgeText: { fontFamily: theme.font.semibold, fontSize: 12 },
  badgeTextAmber: { color: "#92400E" },
  badgeTextRed: { color: theme.color.brandRedDeep },
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
  row: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", gap: theme.space.md },
  rowLabel: { fontFamily: theme.font.regular, fontSize: 14, color: theme.color.textSecondary },
  rowValue: { flexShrink: 1, textAlign: "right", fontFamily: theme.font.semibold, fontSize: 14, color: theme.color.textPrimary },
  link: { color: theme.color.brandRed },
  noteInput: {
    borderWidth: 1,
    borderColor: theme.color.border,
    borderRadius: theme.radius.md,
    padding: theme.space.md,
    minHeight: 88,
    textAlignVertical: "top",
    fontFamily: theme.font.regular,
    fontSize: 15,
    color: theme.color.textPrimary,
  },
  noteError: { fontFamily: theme.font.regular, fontSize: 13, color: theme.color.brandRedDeep },
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
  retryText: { fontFamily: theme.font.semibold, fontSize: 14, color: theme.color.brandRed },
  emptyActivity: { fontFamily: theme.font.regular, fontSize: 14, color: theme.color.textMuted },
  activity: { gap: 2, paddingVertical: theme.space.sm },
  activityMeta: { fontFamily: theme.font.regular, fontSize: 12, color: theme.color.textMuted },
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
