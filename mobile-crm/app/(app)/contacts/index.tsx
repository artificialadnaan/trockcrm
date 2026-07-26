import React, { useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  Linking,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { useRouter } from "expo-router";
import { SafeAreaView } from "react-native-safe-area-context";
import { useQuery } from "@tanstack/react-query";
import { ApiError } from "../../../src/api/client";
import * as contactsApi from "../../../src/api/endpoints/contacts";
import type { ContactListRow } from "../../../src/api/types";
import { useAuth } from "../../../src/auth/AuthContext";
import { useOfficeId } from "../../../src/auth/useOfficeId";
import { qk } from "../../../src/query/keys";
import { theme } from "../../../src/theme/theme";

/** Strip formatting for the dialer; keep a leading + for international numbers. */
function telUrl(phone: string): string {
  return `tel:${phone.replace(/[^\d+]/g, "")}`;
}

export default function ContactsListScreen() {
  const router = useRouter();
  const { fetcher } = useAuth();
  const officeId = useOfficeId();
  const [search, setSearch] = useState("");
  const [submitted, setSubmitted] = useState("");

  const params = { search: submitted || undefined, limit: 50 };
  const query = useQuery({
    queryKey: qk.contacts(officeId, params),
    queryFn: () => contactsApi.listContacts(fetcher, params),
  });

  const contacts = query.data?.contacts ?? [];

  return (
    <SafeAreaView style={styles.safe} edges={["top"]}>
      <View style={styles.header}>
        <Text style={styles.title}>Contacts</Text>
      </View>

      <TextInput
        testID="contacts-search"
        value={search}
        onChangeText={setSearch}
        onSubmitEditing={() => setSubmitted(search.trim())}
        returnKeyType="search"
        placeholder="Search name, company or email"
        placeholderTextColor={theme.color.textMuted}
        autoCapitalize="none"
        autoCorrect={false}
        style={styles.search}
      />

      {query.isLoading ? (
        <View style={styles.center}>
          <ActivityIndicator color={theme.color.brandRed} />
        </View>
      ) : query.error ? (
        <View style={styles.center}>
          <Text style={styles.emptyTitle}>
            {query.error instanceof ApiError && query.error.status === 0
              ? "You're offline"
              : "Couldn't load contacts"}
          </Text>
        </View>
      ) : contacts.length === 0 ? (
        <View style={styles.center}>
          <Text style={styles.emptyTitle}>No contacts</Text>
          <Text style={styles.emptyBody}>
            {submitted ? "Nothing matched that search." : "This office has no contacts yet."}
          </Text>
        </View>
      ) : (
        <FlatList
          data={contacts}
          keyExtractor={(c) => c.id}
          contentContainerStyle={styles.list}
          refreshControl={
            <RefreshControl refreshing={query.isRefetching} onRefresh={() => void query.refetch()} />
          }
          renderItem={({ item }) => (
            <ContactRow contact={item} onOpen={() => router.push(`/(app)/contacts/${item.id}`)} />
          )}
        />
      )}
    </SafeAreaView>
  );
}

function ContactRow({ contact, onOpen }: { contact: ContactListRow; onOpen: () => void }) {
  const company = contactsApi.contactCompanyName(contact);
  const phone = contactsApi.contactPhone(contact);

  return (
    <View style={styles.card}>
      <Pressable
        testID={`contact-${contact.id}`}
        onPress={onOpen}
        accessibilityRole="button"
        accessibilityLabel={`${contact.firstName} ${contact.lastName}`}
        style={styles.cardMain}
      >
        <Text style={styles.name} numberOfLines={1}>
          {contact.firstName} {contact.lastName}
        </Text>
        {contact.jobTitle ? (
          <Text style={styles.meta} numberOfLines={1}>
            {contact.jobTitle}
          </Text>
        ) : null}
        {company ? (
          <Text style={styles.company} numberOfLines={1}>
            {company}
          </Text>
        ) : null}
      </Pressable>

      {/* Calling is the reason this screen exists on a phone — one tap from the list, no detour. */}
      {phone ? (
        <Pressable
          testID={`call-${contact.id}`}
          onPress={() => void Linking.openURL(telUrl(phone)).catch(() => undefined)}
          accessibilityRole="button"
          accessibilityLabel={`Call ${contact.firstName} ${contact.lastName}`}
          style={styles.callBtn}
          hitSlop={8}
        >
          <Text style={styles.callText}>Call</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: theme.color.surfaceMuted },
  header: { paddingHorizontal: theme.space.lg, paddingTop: theme.space.sm },
  title: { fontFamily: theme.font.bold, fontSize: 26, color: theme.color.inkNavy },
  search: {
    margin: theme.space.lg,
    marginBottom: theme.space.sm,
    borderWidth: 1,
    borderColor: theme.color.border,
    borderRadius: theme.radius.md,
    paddingHorizontal: theme.space.md,
    paddingVertical: theme.space.md,
    fontFamily: theme.font.regular,
    fontSize: 15,
    color: theme.color.textPrimary,
    backgroundColor: theme.color.surface,
  },
  list: { padding: theme.space.lg, paddingTop: theme.space.sm, gap: theme.space.md },
  card: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: theme.color.surface,
    borderRadius: theme.radius.lg,
    borderWidth: 1,
    borderColor: theme.color.border,
    padding: theme.space.lg,
    gap: theme.space.md,
  },
  cardMain: { flex: 1, gap: 2 },
  name: { fontFamily: theme.font.bold, fontSize: 16, color: theme.color.inkNavy },
  meta: { fontFamily: theme.font.regular, fontSize: 13, color: theme.color.textMuted },
  company: { fontFamily: theme.font.semibold, fontSize: 14, color: theme.color.textSecondary },
  callBtn: {
    borderRadius: theme.radius.pill,
    borderWidth: 1,
    borderColor: theme.color.brandRed,
    paddingHorizontal: theme.space.lg,
    paddingVertical: theme.space.sm,
  },
  callText: { fontFamily: theme.font.bold, fontSize: 13, color: theme.color.brandRed },
  center: { flex: 1, alignItems: "center", justifyContent: "center", padding: theme.space.xl, gap: theme.space.sm },
  emptyTitle: { fontFamily: theme.font.bold, fontSize: 17, color: theme.color.inkNavy },
  emptyBody: { fontFamily: theme.font.regular, fontSize: 14, color: theme.color.textSecondary, textAlign: "center" },
});
