import React from "react";
import { StyleSheet, Text, View } from "react-native";
import { theme } from "../theme/theme";

export type BadgeTone = "amber" | "red" | "green" | "neutral";

/**
 * A status chip — "On hold", "At risk", "Converted".
 *
 * Shared so the tones stay identical across the deals card, the leads card and the detail screens,
 * which previously hardcoded the same hex literals separately.
 *
 * Keyed by an explicit map rather than nested ternaries: with two tones a ternary was fine, and the
 * moment a third arrived it would have become the kind of expression where adding a fourth quietly
 * lands in the wrong branch.
 *
 * On the dark UI each chip carries a LEADING BAR rather than relying on a tinted pill alone. Dark tints
 * on a dark card are low-contrast by construction, so the bar is what makes a badge findable in
 * peripheral vision — and it encodes status in shape as well as hue, which is the part a red/green
 * colourblind rep can still use.
 */
export function Badge({ label, tone }: { label: string; tone: BadgeTone }) {
  const t = TONE_STYLES[tone];
  return (
    <View style={[styles.pill, t.pill]}>
      <View style={[styles.bar, t.bar]} />
      {/* Uppercased by STYLE, and labelled explicitly, because the style alone is NOT enough.
          VoiceOver reads a short all-caps string as an initialism — "O-N H-O-L-D" — and on iOS RN
          0.81.5 `RCTAttributedTextUtils.mm` applies the transform BEFORE building the attributed
          string, so `RCTParagraphComponentView.accessibilityLabel` falls back to the TRANSFORMED text.
          An earlier version of this comment claimed the transform "stays presentational and the
          accessible name keeps its natural case"; it does not, and that sentence is why twelve
          uppercase labels across this app shipped unreadable. The explicit label is what overrides the
          fallback — caps drawn, words spoken. Guarded by
          `src/__tests__/uppercase-text-has-accessible-label.test.ts`. */}
      <Text accessibilityLabel={label} style={[styles.text, t.text]}>
        {label}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  pill: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.space.xs + 2,
    borderRadius: theme.radius.sm,
    borderWidth: 1,
    paddingLeft: theme.space.xs + 2,
    paddingRight: theme.space.sm,
    paddingVertical: 4,
  },
  bar: { width: 3, alignSelf: "stretch", borderRadius: 2, minHeight: 12 },
  // caption = 11px semibold + tracking, uppercased above. At this size letterspaced small-caps reads as
  // a deliberate label rather than shrunken body copy.
  text: { ...theme.type.caption, textTransform: "uppercase" },

  // Borders come from the TOKENS, not from three new hex literals. This file's own docblock says it
  // exists to stop hardcoded colour duplication, and the first draft reintroduced exactly that two
  // lines below the sentence saying so.
  amber: { backgroundColor: theme.color.amberSurface, borderColor: theme.color.amberBorder },
  amberBar: { backgroundColor: theme.color.amberText },
  amberText: { color: theme.color.amberText },

  red: { backgroundColor: theme.color.redSurface, borderColor: theme.color.redBorder },
  redBar: { backgroundColor: theme.color.redText },
  redText: { color: theme.color.redText },

  green: { backgroundColor: theme.color.greenSurface, borderColor: theme.color.greenBorder },
  greenBar: { backgroundColor: theme.color.greenText },
  greenText: { color: theme.color.greenText },

  neutral: { backgroundColor: theme.color.surfaceMuted, borderColor: theme.color.border },
  neutralBar: { backgroundColor: theme.color.textMuted },
  neutralText: { color: theme.color.textSecondary },
});

const TONE_STYLES: Record<BadgeTone, { pill: object; bar: object; text: object }> = {
  amber: { pill: styles.amber, bar: styles.amberBar, text: styles.amberText },
  red: { pill: styles.red, bar: styles.redBar, text: styles.redText },
  green: { pill: styles.green, bar: styles.greenBar, text: styles.greenText },
  neutral: { pill: styles.neutral, bar: styles.neutralBar, text: styles.neutralText },
};
