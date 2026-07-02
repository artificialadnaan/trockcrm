import React from "react";
import { StyleSheet, Text, View } from "react-native";
import { theme } from "../theme/theme";
import type { ScorecardRatingValue } from "../api/types";

// Color-coded rating pill: Elite (green) / On Standard (blue) / Needs Improvement (amber) / Corrective (red).
const TONE: Record<ScorecardRatingValue, { bg: string; fg: string }> = {
  elite: { bg: "#E7F6EC", fg: "#15803D" },
  on_standard: { bg: "#E7EEFB", fg: "#1D4ED8" },
  needs_improvement: { bg: "#FEF3E2", fg: "#B4650A" },
  corrective_action: { bg: "#FBE9E9", fg: "#B01919" },
};

export function RatingBadge({ rating, label }: { rating: ScorecardRatingValue; label: string }) {
  const tone = TONE[rating] ?? TONE.corrective_action;
  return (
    <View style={[styles.badge, { backgroundColor: tone.bg }]}>
      <Text style={[styles.text, { color: tone.fg }]} numberOfLines={1}>
        {label}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  badge: { alignSelf: "flex-start", borderRadius: theme.radius.pill, paddingHorizontal: 10, paddingVertical: 4 },
  text: { fontFamily: theme.font.semibold, fontSize: 12 },
});
