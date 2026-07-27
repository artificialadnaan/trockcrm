import React, { useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { SafeAreaView } from "react-native-safe-area-context";
import { useQuery } from "@tanstack/react-query";
import { ApiError } from "../../../src/api/client";
import * as contactsApi from "../../../src/api/endpoints/contacts";
import { useAuth } from "../../../src/auth/AuthContext";
import { useQueryScope } from "../../../src/auth/useOfficeId";
import { mailtoUrl, smsUrl, telUrl } from "../../../src/contact-links";
import { openLink } from "../../../src/lib/open-link";
import { formatLocation } from "../../../src/format";
import { qk } from "../../../src/query/keys";
import { theme } from "../../../src/theme/theme";

export default function ContactDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const contactId = typeof id === "string" ? id : "";
  const router = useRouter();
  const { fetcher } = useAuth();
  const cacheScope = useQueryScope();
  // Surfaced under the action row — see openLink on why a silent failure is not acceptable here.
  const [linkError, setLinkError] = useState<string | null>(null);

  const contactQuery = useQuery({
    queryKey: qk.contact(cacheScope, contactId),
    queryFn: () => contactsApi.getContact(fetcher, contactId),
    enabled: contactId.length > 0,
  });

  const dealsQuery = useQuery({
    queryKey: qk.contactDeals(cacheScope, contactId),
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

  // `!contactQuery.data`, NOT `error || !data`. TanStack keeps the loaded contact when a later refetch
  // fails — reconnecting is the common trigger — and keying the blocking state on `error` threw away a
  // perfectly good contact along with every call/text/email action on it, leaving only "Go back".
  if (!contactQuery.data) {
    const offline = contactQuery.error instanceof ApiError && contactQuery.error.status === 0;
    return (
      <SafeAreaView style={styles.safe}>
        <View style={styles.center}>
          <Text style={styles.errorTitle}>{offline ? "You're offline" : "Couldn't load this contact"}</Text>
          <Pressable
            testID="contact-retry"
            onPress={() => void contactQuery.refetch()}
            accessibilityRole="button"
            style={styles.backBtn}
          >
            <Text style={styles.backBtnText}>Try again</Text>
          </Pressable>
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
  // Data is on screen but the last refresh failed — say so without taking the screen away.
  const refreshFailed = Boolean(contactQuery.error);
  // Reps see only the deals they own here — the server scopes this endpoint by assigned rep, unlike the
  // contact record itself, which is office-shared. An empty list does not mean the contact has no deals.
  // Soft-deleted deals are already dropped in getContactDeals; this narrows the type for the render.
  const associations = (dealsQuery.data ?? []).filter(
    (a): a is typeof a & { deal: NonNullable<typeof a.deal> } => Boolean(a.deal),
  );

  return (
    <SafeAreaView style={styles.safe} edges={["top"]}>
      <ScrollView contentContainerStyle={styles.body}>
        <Pressable onPress={() => router.back()} accessibilityRole="button" accessibilityLabel="Back">
          <Text style={styles.back}>‹ Contacts</Text>
        </Pressable>

        {refreshFailed ? (
          <Pressable
            testID="contact-refresh-retry"
            onPress={() => void contactQuery.refetch()}
            accessibilityRole="button"
            style={styles.staleBanner}
          >
            <Text style={styles.staleText}>Showing saved data — couldn&apos;t refresh. Tap to retry.</Text>
          </Pressable>
        ) : null}

        <Text style={styles.name}>
          {contact.firstName} {contact.lastName}
        </Text>
        {contact.jobTitle ? <Text style={styles.jobTitle}>{contact.jobTitle}</Text> : null}
        {company ? <Text style={styles.company}>{company}</Text> : null}

        <View style={styles.actionRow}>
          {/* Call uses the coalesced number — mobile first, landline second — and telUrl preserves any
              stored extension as a dialer pause rather than folding it into the digits. */}
          {phone ? (
            <Action
              testID="call-contact"
              label="Call"
              url={telUrl(phone)}
              accessibilityLabel={`Call ${contact.firstName}`}
              onFailure={setLinkError}
            />
          ) : null}
          {/* Text comes from `mobile` ONLY. Reusing the coalesced number offered to text a landline for
              every landline-only contact — common in this data — and the message silently goes nowhere.
              An extension is never included either: extensions are a dialer concept. */}
          {contact.mobile ? (
            <Action
              testID="text-contact"
              label="Text"
              url={smsUrl(contact.mobile)}
              accessibilityLabel={`Text ${contact.firstName}`}
              onFailure={setLinkError}
            />
          ) : null}
          {contact.email ? (
            <Action
              testID="email-contact"
              label="Email"
              url={mailtoUrl(contact.email)}
              accessibilityLabel={`Email ${contact.firstName}`}
              onFailure={setLinkError}
            />
          ) : null}
        </View>
        {linkError ? (
          <Text testID="contact-link-error" style={styles.linkError}>
            {linkError}
          </Text>
        ) : null}

        <Section title="Details">
          {contact.category ? <Row label="Category" value={contactsApi.categoryLabel(contact.category)} /> : null}
          {phone ? <Row label="Phone" value={phone} /> : null}
          {contact.email ? <Row label="Email" value={contact.email} /> : null}
          {location ? <Row label="Location" value={location} /> : null}
          {/* This count comes from buildContactLinkedDealsCountSql, which filters d.is_active = true —
              the same predicate getContactDeals now applies — but is NOT rep-scoped, while the Deals
              section below is. For a rep the two can therefore differ, deliberately: the count is what
              the office has, the list is what this user may open. The empty state says so in words. */}
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
          ) : dealsQuery.error && dealsQuery.data === undefined ? (
            // A FAILED request is not an empty result. Rendering "no deals are linked" on a 5xx presents
            // a network failure as a fact about the contact, and a rep would act on it — calling someone
            // believing they have no live work when they may have several.
            //
            // Gated on `data === undefined`, not on row count: a contact with genuinely no visible deals
            // HAS loaded, so a later failed refetch belongs inline below rather than replacing the real
            // empty state. Same distinction as both lists and the activity timeline.
            <Pressable
              testID="retry-contact-deals"
              onPress={() => void dealsQuery.refetch()}
              accessibilityRole="button"
              style={styles.retry}
            >
              <Text style={styles.retryText}>Couldn&apos;t load deals — tap to retry</Text>
            </Pressable>
          ) : associations.length === 0 ? (
            <Text style={styles.emptyBody}>No deals you can see are linked to this contact.</Text>
          ) : (
            associations.map((assoc) => (
              <Pressable
                key={assoc.id}
                testID={`contact-deal-${assoc.deal.id}`}
                onPress={() => router.push(`/(app)/deals/${assoc.deal.id}`)}
                accessibilityRole="button"
                style={styles.dealRow}
              >
                <Text style={styles.dealName} numberOfLines={1}>
                  {assoc.deal.name ?? "Untitled deal"}
                </Text>
                <Text style={styles.dealChevron}>›</Text>
              </Pressable>
            ))
          )}

          {/* A background failure once the linked deals have loaded: never replace what is on screen,
              just say so. Gated on `data !== undefined` rather than on row count — and this is the case
              that matters most, because reps see only their OWN deals here, so an empty result is the
              NORMAL one. Requiring rows meant the most common state reported a failed refresh nowhere:
              no notice, no retry, just "No deals you can see are linked to this contact" standing there
              looking authoritative while the refresh behind it had failed. */}
          {dealsQuery.data !== undefined && dealsQuery.error ? (
            <Pressable
              testID="retry-contact-deals-inline"
              onPress={() => void dealsQuery.refetch()}
              accessibilityRole="button"
              style={styles.retry}
            >
              <Text style={styles.retryText}>Couldn&apos;t refresh deals — tap to retry</Text>
            </Pressable>
          ) : null}
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
  onFailure,
}: {
  testID: string;
  label: string;
  url: string;
  accessibilityLabel: string;
  // Nullable: openLink reports null on success, which clears a previous failure.
  onFailure: (message: string | null) => void;
}) {
  return (
    <Pressable
      testID={testID}
      onPress={() => void openLink(url, onFailure)}
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
  linkError: { fontFamily: theme.font.regular, fontSize: 13, color: theme.color.brandRedDeep },
  retry: { paddingVertical: theme.space.sm },
  staleBanner: {
    marginTop: theme.space.sm,
    borderRadius: theme.radius.md,
    backgroundColor: "#FEF3C7",
    paddingHorizontal: theme.space.md,
    paddingVertical: theme.space.sm,
  },
  staleText: { fontFamily: theme.font.semibold, fontSize: 13, color: "#92400E" },
  retryText: { fontFamily: theme.font.semibold, fontSize: 14, color: theme.color.brandRed },
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
