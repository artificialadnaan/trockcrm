import React from "react";
import { Pressable, StyleSheet, Text } from "react-native";
import { theme } from "../theme/theme";

/**
 * The back control every detail and form screen puts at the top left.
 *
 * Shared because five screens had written it out by hand and it had drifted three ways at once:
 *
 *   - SIZE. Four of the five wrapped a bare `<Text>` in a Pressable with no style at all, so the tap
 *     target was the text's own line box — about 18pt against the HIG's 44. Two added `hitSlop={8}`,
 *     reaching 34. `board.tsx` and `prospect.tsx` had both been built to a proper 44 and the rule simply
 *     never came back to the screens a rep opens most, in gloves, on a roof.
 *   - NAME. Three of them had no `accessibilityLabel`, so VoiceOver announced the decorative chevron as
 *     part of the control: "‹ Cancel".
 *   - WEIGHT. `stage/[stageId].tsx` used `theme.type.body` (regular) where the other four used semibold
 *     at the same size and colour — the one-file divergence nobody could see next to the other four.
 *
 * THE ACCESSIBLE NAME CONTAINS THE VISIBLE TEXT. It was a flat "Back", which is WCAG 2.5.3 Label in
 * Name backwards: a Voice Control user says "Tap Cancel" because the control reads "‹ Cancel", and a
 * name of "Back" does not match, so the command does nothing. It also threw away the one piece of
 * information the label carries — on a screen reachable by deep link, where the destination is not
 * obvious, "Cancel" and "Deals" are different promises. Default is `Back to {label}`, which contains
 * the visible word; `accessibleName` overrides it where that reads wrong ("Back to Cancel" does not
 * mean anything). Only the decorative chevron is omitted.
 *
 * `alignSelf: "flex-start"` keeps the target the width of its text. Without it the Pressable stretches
 * to the full column, and a 44pt-tall full-width band across the top of the screen is a large invisible
 * control sitting over the title — bigger is not automatically better when the extra area is unmarked.
 */
export function BackLink({
  label,
  onPress,
  accessibleName,
}: {
  label: string;
  onPress: () => void;
  /** Overrides the default `Back to {label}`. Must still CONTAIN `label` — see the note above. */
  accessibleName?: string;
}) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={accessibleName ?? `Back to ${label}`}
      // Stacks with the floor rather than substituting for it: the drawn control is 44pt, and the
      // forgiving margin around it is extra.
      hitSlop={8}
      style={styles.link}
    >
      <Text style={styles.text}>‹ {label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  link: { minHeight: 44, justifyContent: "center", alignSelf: "flex-start" },
  text: { fontFamily: theme.font.semibold, fontSize: 15, color: theme.color.redText },
});
