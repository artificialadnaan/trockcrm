import React from "react";
import { ActivityIndicator, Linking, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { SafeAreaView } from "react-native-safe-area-context";
import { useQuery } from "@tanstack/react-query";
import { ApiError } from "../../../src/api/client";
import * as contactsApi from "../../../src/api/endpoints/contacts";
import { useAuth } from "../../../src/auth/AuthContext";
import { useOfficeId } from "../../../src/auth/useOfficeId";
import { formatLocation } from "../../../src/format";
import { qk } from "../../../src/query/keys";
import { theme } from "../../../src/theme/theme";

function dialable(phone: string): string {
  return phone.replace(/[^\d+]/g, "");
}

export default function ContactDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const contactId = typeof id === "string" ? id : "";
  const router = useRouter();
  const { fetcher } = useAuth();
  const officeId = useOfficeId();

  const contactQuery = useQuery({
    queryKey: qk.contact(officeId, contactId),
    queryFn: () => contactsApi.getContact(fetcher, contactId),
    enabled: contactId.length > 0,
  });

  const dealsQuery = useQuery({
    queryKey: qk.contactDeals(officeId, contactId),
    queryFn: () => contactsApi.getContactDeals(fetcher, contactId),
    enabled: contactId.length > 0,
  });

  if (contactQuery.isLoading) {
    return (
      <SafeAreaView style={styles.safe}>
        <View style={styles.center}>
          <ActivityIndicator color={theme.color.brandRed} />
        </View>
      </SafeAreaView>
    );
  }

  if (contactQuery.error || !contactQuery.data) {
    const offline = contactQuery.error instanceof ApiError && contactQuery.error.status === 0;
    return (
      <SafeAreaView style={styles.safe}>
        <View style={styles.center}>
          <Text style={styles.errorTitle}>{offline ? "You're offline" : "Couldn't load this contact"}</Text>
          <Pressable onPress={() => router.back()} accessibilityRole="button" style={styles.backBtn}>
            <Text style={styles.backBtnText}>Go back</Text>
          </Pressable>
        </View>
      </SafeAreaView>
    );
  }

  const contact = contactQuery.data;
  const company = contactsApi.contactCompanyName(contact);
  const phone = contactsApi.contactPhone(contact);
  const location = formatLocation(contact.city, contact.state);
  // Reps see only the deals they own here — the server scopes this endpoint by assigned rep, unlike the
  // contact record itself, which is office-shared. An empty list does not mean the contact has no deals.
  const associations = (dealsQuery.data ?? []).filter((a) => a.deal);

  return (
    <SafeAreaView style={styles.safe} edges={["top"]}>
      <ScrollView contentContainerStyle={styles.body}>
        <Pressable onPress={() => router.back()} accessibilityRole="button" accessibilityLabel="Back">
          <Text style={styles.back}>‹ Contacts</Text>
        </Pressable>

        <Text style={styles.name}>
          {contact.firstName} {contact.lastName}
        </Text>
        {contact.jobTitle ? <Text style={styles.jobTitle}>{contact.jobTitle}</Text> : null}
        {company ? <Text style={styles.company}>{company}</Text> : null}

        <View style={styles.actionRow}>
          {phone ? (
            <>
              <Action
                testID="call-contact"
                label="Call"
                url={`tel:${dialable(phone)}`}
                accessibilityLabel={`Call ${contact.firstName}`}
              />
              <Action
                testID="text-contact"
                label="Text"
                url={`sms:${dialable(phone)}`}
                accessibilityLabel={`Text ${contact.firstName}`}
              />
            </>
          ) : null}
          {contact.email ? (
            <Action
              testID="email-contact"
              label="Email"
              url={`mailto:${contact.email}`}
              accessibilityLabel={`Email ${contact.firstName}`}
            />
          ) : null}
        </View>

        <Section title="Details">
          {contact.category ? <Row label="Category" value={contactsApi.categoryLabel(contact.category)} /> : null}
          {phone ? <Row label="Phone" value={phone} /> : null}
          {contact.email ? <Row label="Email" value={contact.email} /> : null}
          {location ? <Row label="Location" value={location} /> : null}
          <Row label="Linked deals" value={String(contact.linkedDealsCount ?? 0)} />
        </Section>

        {contact.notes ? (
          <Section title="Notes">
            <Text style={styles.notes}>{contact.notes}</Text>
          </Section>
        ) : null}

        <Section title="Deals">
          {dealsQuery.isLoading ? (
            <ActivityIndicator color={theme.color.brandRed} />
          ) : associations.length === 0 ? (
            <Text style={styles.emptyBody}>No deals you can see are linked to this contact.</Text>
          ) : (
            associations.map((assoc) => (
              <Pressable
                key={assoc.id}
                testID={`contact-deal-${assoc.deal!.id}`}
                onPress={() => router.push(`/(app)/deals/${assoc.deal!.id}`)}
                accessibilityRole="button"
                style={styles.dealRow}
              >
                <Text style={styles.dealName} numberOfLines={1}>
                  {assoc.deal!.name ?? "Untitled deal"}
                </Text>
                <Text style={styles.dealChevron}>›</Text>
              </Pressable>
            ))
          )}
        </Section>
      </ScrollView>
    </SafeAreaView>
  );
}

function Action({
  testID,
  label,
  url,
  accessibilityLabel,
}: {
  testID: string;
  label: string;
  url: string;
  accessibilityLabel: string;
}) {
  return (
    <Pressable
      testID={testID}
      onPress={() => void Linking.openURL(url).catch(() => undefined)}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      style={styles.action}
    >
      <Text style={styles.actionText}>{label}</Text>
    </Pressable>
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

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: theme.color.surfaceMuted },
  body: { padding: theme.space.lg, paddingBottom: theme.space.xxl },
  center: { flex: 1, alignItems: "center", justifyContent: "center", gap: theme.space.md },
  back: { fontFamily: theme.font.semibold, fontSize: 15, color: theme.color.brandRed },
  name: { fontFamily: theme.font.bold, fontSize: 24, color: theme.color.inkNavy, marginTop: theme.space.sm },
  jobTitle: { fontFamily: theme.font.regular, fontSize: 14, color: theme.color.textMuted },
  company: { fontFamily: theme.font.semibold, fontSize: 15, color: theme.color.textSecondary },
  actionRow: { flexDirection: "row", gap: theme.space.sm, marginTop: theme.space.lg },
  action: {
    flex: 1,
    backgroundColor: theme.color.brandRed,
    borderRadius: theme.radius.md,
    paddingVertical: theme.space.md,
    alignItems: "center",
  },
  actionText: { fontFamily: theme.font.bold, fontSize: 14, color: theme.color.textInverse },
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
  notes: { fontFamily: theme.font.regular, fontSize: 14, color: theme.color.textSecondary },
  emptyBody: { fontFamily: theme.font.regular, fontSize: 14, color: theme.color.textMuted },
  dealRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingVertical: theme.space.sm },
  dealName: { flex: 1, fontFamily: theme.font.semibold, fontSize: 14, color: theme.color.textPrimary },
  dealChevron: { fontFamily: theme.font.bold, fontSize: 18, color: theme.color.textMuted },
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
