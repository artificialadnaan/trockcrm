import React from "react";
import { StyleSheet, Text, View } from "react-native";
import { theme } from "../theme/theme";

/**
 * A label/value row — the detail-list primitive used by the dashboard and every detail screen.
 *
 * Shared rather than redefined per screen: three independent copies had already appeared, and a
 * label/value row is exactly the kind of thing that drifts (alignment, truncation, colour) once each
 * screen owns its own.
 */
export function Row({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.row}>
      <Text style={styles.label}>{label}</Text>
      <Text style={styles.value}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    gap: theme.space.md,
  },
  label: { fontFamily: theme.font.regular, fontSize: 14, color: theme.color.textSecondary },
  value: {
    flexShrink: 1,
    textAlign: "right",
    fontFamily: theme.font.semibold,
    fontSize: 14,
    color: theme.color.textPrimary,
  },
});
