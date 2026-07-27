import React from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import type { LeadListItem } from "../api/types";
import { Badge } from "./Badge";
import { formatDate, formatLocation } from "../format";
import { theme } from "../theme/theme";

/**
 * One lead in the list.
 *
 * Memoised, with a STABLE onPress expected from the caller — an inline closure gives every card a fresh
 * prop on each render and defeats the memo entirely, which on a list is the whole viewport re-rendering
 * per keystroke in the search field.
 */
export const LeadCard = React.memo(function LeadCard({
  lead,
  stageName,
  onPress,
}: {
  lead: LeadListItem;
  stageName?: string;
  onPress: (lead: LeadListItem) => void;
}) {
  const location = formatLocation(lead.property?.city, lead.property?.state);
  // `projectType` is an OBJECT on reads — rendering it directly prints "[object Object]".
  const projectTypeName = lead.projectType?.name ?? null;
  const converted = lead.status === "converted";
  const disqualified = lead.status === "disqualified";

  return (
    <Pressable
      testID={`lead-card-${lead.id}`}
      onPress={() => onPress(lead)}
      accessibilityRole="button"
      accessibilityLabel={lead.name ?? "Untitled lead"}
      style={styles.card}
    >
      <View style={styles.head}>
        <Text style={styles.name} numberOfLines={1}>
          {lead.name ?? "Untitled lead"}
        </Text>
        {stageName ? <Text style={styles.stage}>{stageName}</Text> : null}
      </View>

      {lead.companyName ? (
        <Text style={styles.company} numberOfLines={1}>
          {lead.companyName}
        </Text>
      ) : null}

      <Text style={styles.meta} numberOfLines={1}>
        {[projectTypeName, location, lead.assignedRepName].filter(Boolean).join(" · ") || "—"}
      </Text>

      <View style={styles.badges}>
        {/* Terminal status earns a badge because it changes what can be DONE with the row: a converted
            or disqualified lead is readable but cannot be moved, and a card that looks identical to an
            open one invites a tap that goes nowhere. */}
        {converted ? <Badge label="Converted" tone="green" /> : null}
        {disqualified ? <Badge label="Disqualified" tone="amber" /> : null}
        {/* The server's own display axis — the same date it filters on, so the list cannot show one date
            while a date filter acts on another. */}
        {lead.displayDate ? <Text style={styles.date}>{formatDate(lead.displayDate)}</Text> : null}
      </View>
    </Pressable>
  );
});

const styles = StyleSheet.create({
  card: {
    backgroundColor: theme.color.surface,
    borderRadius: theme.radius.lg,
    borderWidth: 1,
    borderColor: theme.color.border,
    padding: theme.space.lg,
    gap: theme.space.xs,
  },
  head: { flexDirection: "row", justifyContent: "space-between", gap: theme.space.sm },
  name: { flex: 1, fontFamily: theme.font.bold, fontSize: 15, color: theme.color.inkNavy },
  stage: { fontFamily: theme.font.semibold, fontSize: 12, color: theme.color.textSecondary },
  company: { fontFamily: theme.font.semibold, fontSize: 13, color: theme.color.textSecondary },
  meta: { fontFamily: theme.font.regular, fontSize: 13, color: theme.color.textMuted },
  badges: {
    flexDirection: "row",
    alignItems: "center",
    flexWrap: "wrap",
    gap: theme.space.sm,
    marginTop: theme.space.xs,
  },
  date: { fontFamily: theme.font.regular, fontSize: 12, color: theme.color.textMuted },
});
