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

/** One company: what it is, where, and how much of the pipeline it carries. */
export default function CompanyDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const companyId = typeof id === "string" ? id : "";
  const goBack = useGoBack("/(app)/companies");
  const { fetcher } = useAuth();
  const scope = useQueryScope();

  const query = useQuery({
    queryKey: qk.company(scope, companyId),
    queryFn: () => directoryApi.getCompany(fetcher, companyId),
    enabled: companyId.length > 0,
  });

  const company = query.data;
  const offline = query.error instanceof ApiError && query.error.status === 0;

  return (
    <SafeAreaView style={styles.safe} edges={["top"]}>
      <View style={styles.header}>
        <BackLink label="Companies" onPress={() => goBack()} />
        <Text accessibilityRole="header" style={styles.title}>
          {company?.name ?? "Company"}
        </Text>
      </View>

      {!company && query.isLoading ? (
        <View style={styles.center}>
          <ActivityIndicator color={theme.color.brandRed} />
        </View>
      ) : !company ? (
        <View style={styles.center}>
          <RetryBlock
            testID="company-retry"
            title={offline ? "No signal" : "Couldn't load this company"}
            onRetry={() => void query.refetch()}
            retrying={query.isFetching}
          />
        </View>
      ) : (
        <ScrollView contentContainerStyle={styles.body}>
          {company.category ? (
            <Text accessibilityLabel={company.category} style={styles.company} numberOfLines={2}>
              {company.category}
            </Text>
          ) : null}

          <View style={styles.section}>
            <Row label="Location" value={formatLocation(company.city, company.state) || "—"} />
            {company.industry ? <Row label="Industry" value={company.industry} /> : null}
            {company.phone ? <Row label="Phone" value={company.phone} /> : null}
            {company.website ? <Row label="Website" value={company.website} /> : null}
          </View>

          {/* Counts the server already folded onto the record. "Active of total" rather than a bare
              number, because a company with 1 of 12 live is a different account from one with 12. */}
          {company.activeDealCount != null && company.totalDealCount != null ? (
            <View style={styles.section}>
              <Row
                label="Deals"
                value={`${company.activeDealCount} active of ${company.totalDealCount}`}
              />
              {company.contactCount != null ? (
                <Row label="Contacts" value={String(company.contactCount)} />
              ) : null}
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
