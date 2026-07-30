import React from "react";
import { ActivityIndicator, ScrollView, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useQuery } from "@tanstack/react-query";
import { useLocalSearchParams } from "expo-router";
import { ApiError } from "../../../src/api/client";
import * as directoryApi from "../../../src/api/endpoints/directory";
import { useAuth } from "../../../src/auth/AuthContext";
import { useQueryScope } from "../../../src/auth/useOfficeId";
import { BackLink } from "../../../src/components/BackLink";
import { RetryBlock } from "../../../src/components/RetryBlock";
import { Row } from "../../../src/components/Row";
import { formatLocation } from "../../../src/format";
import { useGoBack } from "../../../src/lib/go-back";
import { qk } from "../../../src/query/keys";
import { theme } from "../../../src/theme/theme";

/** One building: what it is, who owns it, and where. */
export default function PropertyDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const propertyId = typeof id === "string" ? id : "";
  const goBack = useGoBack("/(app)/properties");
  const { fetcher } = useAuth();
  const scope = useQueryScope();

  const query = useQuery({
    queryKey: qk.property(scope, propertyId),
    queryFn: () => directoryApi.getProperty(fetcher, propertyId),
    enabled: propertyId.length > 0,
  });

  const property = query.data;
  const offline = query.error instanceof ApiError && query.error.status === 0;

  return (
    <SafeAreaView style={styles.safe} edges={["top"]}>
      <View style={styles.header}>
        <BackLink label="Properties" onPress={() => goBack()} />
        <Text accessibilityRole="header" style={styles.title}>
          {property?.name ?? "Property"}
        </Text>
      </View>

      {!property && query.isLoading ? (
        <View style={styles.center}>
          <ActivityIndicator color={theme.color.brandRed} />
        </View>
      ) : !property ? (
        <View style={styles.center}>
          <RetryBlock
            testID="property-retry"
            title={offline ? "No signal" : "Couldn't load this property"}
            onRetry={() => void query.refetch()}
            retrying={query.isFetching}
          />
        </View>
      ) : (
        <ScrollView contentContainerStyle={styles.body}>
          {property.companyName ? (
            <Text
              accessibilityLabel={property.companyName}
              style={styles.company}
              numberOfLines={2}
            >
              {property.companyName}
            </Text>
          ) : null}

          <View style={styles.section}>
            <Row label="Address" value={property.address || "—"} />
            <Row label="City" value={formatLocation(property.city, property.state) || "—"} />
            <Row label="ZIP" value={property.zip || "—"} />
            {/* `propertyType ?? type` — the server selects both columns and either can hold the
                classification, which is why the web detail reads them the same way. Checking only one
                dropped the Type row for every property carrying the other. */}
            {property.propertyType ?? property.type ? (
              <Row label="Type" value={(property.propertyType ?? property.type) as string} />
            ) : null}
            {property.buildYear ? <Row label="Built" value={String(property.buildYear)} /> : null}
            {property.unitCount ? <Row label="Units" value={String(property.unitCount)} /> : null}
          </View>

          {/**
            * Coordinates are shown as PRESENT or ABSENT rather than as numbers.
            *
            * Nothing on a phone is served by two decimals of latitude, but whether a building has
            * coordinates at all is real information: only properties created since field prospecting
            * shipped have them, and a building without them can never be matched by proximity when a
            * rep is standing outside it.
            */}
          <Text style={styles.note}>
            {property.lat != null && property.lng != null
              ? "Has coordinates — a rep standing here can match it by proximity."
              : "No coordinates yet. It can be found by address, but not by standing at it."}
          </Text>

          {property.notes ? (
            <View style={styles.section}>
              {/* Labelled: `sectionLabel` uppercases by transform, which on iOS becomes the accessible
                  name itself. */}
              <Text accessibilityLabel="Notes" style={styles.sectionLabel}>
                NOTES
              </Text>
              <Text style={styles.notes}>{property.notes}</Text>
            </View>
          ) : null}
        </ScrollView>
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
  center: { flex: 1, alignItems: "center", justifyContent: "center", padding: theme.space.lg },
  body: { padding: theme.space.lg, gap: theme.space.md, paddingBottom: theme.space.xxl },
  company: { ...theme.type.caption, textTransform: "uppercase", color: theme.color.textMuted },
  section: {
    backgroundColor: theme.color.surface,
    borderRadius: theme.radius.lg,
    borderWidth: 1,
    borderColor: theme.color.border,
    padding: theme.space.lg,
    gap: theme.space.sm,
  },
  sectionLabel: { ...theme.type.caption, textTransform: "uppercase", color: theme.color.textMuted },
  notes: { ...theme.type.body, color: theme.color.textSecondary },
  note: { ...theme.type.small, color: theme.color.textMuted },
});
