import React from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import type { FieldScorecardSummary } from "../api/types";
import { formatShortDate } from "../scorecards/detail-view";
import { theme } from "../theme/theme";
import { RatingBadge } from "./RatingBadge";

export function SubmittedScorecardRow({
  scorecard,
  onPress,
}: {
  scorecard: FieldScorecardSummary;
  onPress: () => void;
}) {
  const isLeadership = scorecard.kind === "leadership";
  const scoreText = isLeadership
    ? `${(scorecard.averageScore ?? scorecard.totalScore / 10).toFixed(1)}/10`
    : `${scorecard.totalScore}/100`;
  const canonicalProjectName = scorecard.projectName?.trim();
  const projectName =
    canonicalProjectName || (scorecard.projectNumber ? `Project ${scorecard.projectNumber}` : "Untitled project");
  const metadata = [
    isLeadership ? "Leadership" : null,
    canonicalProjectName ? scorecard.projectNumber : null,
    `Week of ${formatShortDate(scorecard.weekOf)}`,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${isLeadership ? "Leadership scorecard" : "Scorecard"} for ${projectName}${
        canonicalProjectName && scorecard.projectNumber ? `, project ${scorecard.projectNumber}` : ""
      }, week of ${formatShortDate(scorecard.weekOf)}, ${scoreText}, ${scorecard.ratingLabel}`}
      onPress={onPress}
      style={({ pressed }) => [styles.row, pressed && { opacity: 0.7 }]}
    >
      <View style={styles.content}>
        <Text style={styles.title} numberOfLines={2}>
          {projectName}
        </Text>
        <Text style={styles.meta} numberOfLines={1}>
          {metadata}
        </Text>
        <RatingBadge rating={scorecard.rating} label={`${scoreText} · ${scorecard.ratingLabel}`} />
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.space.md,
    backgroundColor: theme.color.surfaceCard,
    borderWidth: 1,
    borderColor: theme.color.border,
    borderRadius: theme.radius.md,
    padding: theme.space.md,
  },
  content: { flex: 1, gap: 4 },
  title: { fontFamily: theme.font.semibold, fontSize: 15, color: theme.color.textPrimary },
  meta: { fontFamily: theme.font.body, fontSize: 13, color: theme.color.textMuted },
});
