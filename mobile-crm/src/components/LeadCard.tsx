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
      /* EVERYTHING the card shows, in the order it shows it.
         An explicit label REPLACES the text assembled from the children, so whatever is left out of
         this array is not merely unannounced — it becomes unreachable. The first version listed the
         name, stage and lifecycle only, which made every sighted-only detail invisible: two leads for
         the same company at the same stage were indistinguishable by ear, and the rep had to open each
         one to tell them apart. Built from the SAME values the JSX renders, so a line that is hidden
         because it is empty is absent here too. */
      accessibilityLabel={[
        lead.name ?? "Untitled lead",
        stageName,
        converted ? "Converted" : disqualified ? "Disqualified" : null,
        lead.companyName,
        projectTypeName,
        location,
        lead.assignedRepName,
        lead.displayDate ? formatDate(lead.displayDate) : null,
      ]
        .filter(Boolean)
        .join(", ")}
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
    minHeight: 44,
    justifyContent: "center",
    backgroundColor: theme.color.surface,
    borderRadius: theme.radius.lg,
    borderWidth: 1,
    borderColor: theme.color.border,
    padding: theme.space.lg,
    gap: theme.space.xs,
  },
  head: { flexDirection: "row", justifyContent: "space-between", gap: theme.space.sm },
  name: { flex: 1, ...theme.type.title, color: theme.color.textPrimary },
  stage: { ...theme.type.caption, color: theme.color.textSecondary },
  company: { ...theme.type.caption, color: theme.color.textMuted, textTransform: "uppercase" },
  /* textSecondary (8.3:1 on surface), NOT textMuted (4.99:1) — the same call the tab bar documents.
     This is the whole content of the card besides the name: project type, location and the assigned
     rep. Ratios are against the DARK surface; the figures here used to be "on the white card", which
     described a theme this app no longer ships. */
  meta: { ...theme.type.label, color: theme.color.textSecondary },
  badges: {
    flexDirection: "row",
    alignItems: "center",
    flexWrap: "wrap",
    gap: theme.space.sm,
    marginTop: theme.space.xs,
  },
  date: { ...theme.type.caption, color: theme.color.textSecondary },
});
