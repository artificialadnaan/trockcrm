import React from "react";
import { StyleSheet, Text, View } from "react-native";
import { theme } from "../theme/theme";

export type BadgeTone = "amber" | "red" | "green";

/**
 * A status pill — "On hold", "At risk", "Converted". Shared so the tones stay identical across the deals
 * card, the leads card and the detail screens, which previously hardcoded the same hex literals
 * separately.
 *
 * Keyed by an explicit map rather than nested ternaries: with two tones a ternary was fine, and the
 * moment a third arrived it would have become the kind of expression where adding a fourth quietly
 * lands in the wrong branch.
 */
export function Badge({ label, tone }: { label: string; tone: BadgeTone }) {
  return (
    <View style={[styles.pill, TONE_STYLES[tone].pill]}>
      <Text style={[styles.text, TONE_STYLES[tone].text]}>{label}</Text>
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
  green: { backgroundColor: theme.color.greenSurface },
  greenText: { color: theme.color.greenText },
});

const TONE_STYLES: Record<BadgeTone, { pill: object; text: object }> = {
  amber: { pill: styles.amber, text: styles.amberText },
  red: { pill: styles.red, text: styles.redText },
  green: { pill: styles.green, text: styles.greenText },
};
