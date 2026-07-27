import React from "react";
import { StyleSheet, Text, View } from "react-native";
import { theme } from "../theme/theme";

export type BadgeTone = "amber" | "red";

/**
 * A status pill — "On hold", "At risk". Shared so the two tones stay identical across the deals card and
 * the detail screen, which previously hardcoded the same hex literals separately.
 */
export function Badge({ label, tone }: { label: string; tone: BadgeTone }) {
  return (
    <View style={[styles.pill, tone === "amber" ? styles.amber : styles.red]}>
      <Text style={[styles.text, tone === "amber" ? styles.amberText : styles.redText]}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  pill: { borderRadius: theme.radius.pill, paddingHorizontal: theme.space.md, paddingVertical: 3 },
  text: { fontFamily: theme.font.semibold, fontSize: 12 },
  amber: { backgroundColor: theme.color.amberSurface },
  amberText: { color: theme.color.amberText },
  red: { backgroundColor: theme.color.redSurface },
  redText: { color: theme.color.brandRedDeep },
});
