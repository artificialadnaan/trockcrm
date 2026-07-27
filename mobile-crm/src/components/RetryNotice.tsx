import React from "react";
import { Pressable, StyleSheet, Text } from "react-native";
import { theme } from "../theme/theme";

/**
 * An inline "that didn't work — tap to retry" strip for a list that already has data on screen.
 *
 * WHERE it renders is the point. A failed pull-to-refresh has to appear at the TOP, next to the gesture
 * the user just made: with a full page loaded they are still at the top afterwards, so a footer message
 * sits below fifty rows, off-screen. The refresh then looks like it succeeded while stale data stays up
 * — a silent failure disguised as a successful one.
 *
 * A failed load-more is the opposite: the user is at the BOTTOM when it happens, so the footer is
 * exactly where they are looking.
 *
 * Shared because both lists need both placements, and every time this app has expressed the same idea
 * twice, one copy has been wrong.
 */
export function RetryNotice({
  testID,
  message,
  onRetry,
  placement,
}: {
  testID: string;
  message: string;
  onRetry: () => void;
  placement: "top" | "bottom";
}) {
  return (
    <Pressable
      testID={testID}
      onPress={onRetry}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabelFor(message)}
      style={[styles.notice, placement === "top" ? styles.top : styles.bottom]}
    >
      <Text style={styles.text}>{message}</Text>
    </Pressable>
  );
}

/**
 * The spoken label, without saying "tap to retry" twice.
 *
 * Most call sites already end their message with the instruction because it is useful VISUALLY, and the
 * label appended a second copy — VoiceOver read "tap to retry. Tap to retry." The visible text is left
 * exactly as the caller wrote it; only the announcement is de-duplicated, so fixing this cannot change
 * what anyone sees. Matching on the phrase rather than requiring every caller to drop it keeps the two
 * from drifting the next time a notice is added.
 */
export function accessibilityLabelFor(message: string): string {
  const trimmed = message.trim();
  const alreadyInstructs = /tap to (retry|try again)\.?$/i.test(trimmed);
  if (alreadyInstructs) return trimmed.endsWith(".") ? trimmed : `${trimmed}.`;
  return `${trimmed.replace(/\.?$/, "")}. Tap to retry.`;
}

const styles = StyleSheet.create({
  notice: {
    borderRadius: theme.radius.md,
    backgroundColor: theme.color.amberSurface,
    paddingHorizontal: theme.space.md,
    paddingVertical: theme.space.sm,
    alignItems: "center",
  },
  top: { marginBottom: theme.space.md },
  bottom: { marginTop: theme.space.md },
  text: { fontFamily: theme.font.semibold, fontSize: 13, color: theme.color.amberText },
});
