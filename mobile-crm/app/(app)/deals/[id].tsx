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
import { useOfficeId } from "../../../src/auth/useOfficeId";
import { displayAmount, showsAtRisk } from "../../../src/components/DealCard";
import { daysSince, formatDate, formatLocation } from "../../../src/format";
import { qk } from "../../../src/query/keys";
import { theme } from "../../../src/theme/theme";

export default function DealDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const dealId = typeof id === "string" ? id : "";
  const router = useRouter();
  const { fetcher } = useAuth();
  const officeId = useOfficeId();
  const queryClient = useQueryClient();
  const [note, setNote] = useState("");

  const dealQuery = useQuery({
    queryKey: qk.deal(officeId, dealId),
    queryFn: () => dealsApi.getDealDetail(fetcher, dealId),
    enabled: dealId.length > 0,
  });

  const activitiesQuery = useQuery({
    queryKey: qk.dealActivities(officeId, dealId),
    queryFn: () => dealsApi.listActivities(fetcher, dealId),
    enabled: dealId.length > 0,
  });

  const logNote = useMutation({
    mutationFn: (notes: string) =>
      dealsApi.createActivity(fetcher, { dealId, activityType: "note", notes }),
    onSuccess: async () => {
      setNote("");
      await queryClient.invalidateQueries({ queryKey: qk.dealActivities(officeId, dealId) });
    },
  });

  const watch = useMutation({
    mutationFn: (next: boolean) =>
      next ? dealsApi.watchDeal(fetcher, dealId) : dealsApi.unwatchDeal(fetcher, dealId),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: qk.deal(officeId, dealId) });
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
  const stageDays = daysSince(deal.stageEnteredAt);
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
          ) : (activitiesQuery.data ?? []).length === 0 ? (
            <Text style={styles.emptyActivity}>Nothing logged yet.</Text>
          ) : (
            (activitiesQuery.data ?? []).map((a) => (
              <View key={a.id} style={styles.activity}>
                <Text style={styles.activityMeta}>
                  {a.activityType}
                  {a.createdByName ? ` · ${a.createdByName}` : ""}
                  {a.createdAt ? ` · ${formatDate(a.createdAt)}` : ""}
                </Text>
                {a.subject ? <Text style={styles.activitySubject}>{a.subject}</Text> : null}
                {a.notes ? <Text style={styles.activityNotes}>{a.notes}</Text> : null}
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
