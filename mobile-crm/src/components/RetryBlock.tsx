import React from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";
import { theme } from "../theme/theme";

/**
 * The BLOCKING counterpart to RetryNotice: a section whose content failed to load and has nothing to
 * show, so the work that depends on it cannot proceed at all.
 *
 * The distinction between the two is worth keeping sharp, because picking the wrong one is a real bug
 * rather than a style choice:
 *
 *   RetryNotice — data IS on screen, a refresh or a next page failed. Non-blocking. The user can keep
 *                 working with what they have, so it is a strip that must not take over the view.
 *   RetryBlock  — nothing loaded. The user cannot proceed. Saying so plainly, with the retry attached,
 *                 is the only honest rendering.
 *
 * What this replaces is the failure mode this app keeps producing: `query.data ?? []` mapped over an
 * empty array, so a failed fetch renders pixel-for-pixel identically to a genuinely empty result. The
 * user is told there is nothing rather than that we could not find out — and is given no way to retry
 * short of backing out and re-entering the screen.
 */
export function RetryBlock({
  testID,
  title,
  body,
  onRetry,
  retrying,
}: {
  testID: string;
  title: string;
  body?: string;
  onRetry: () => void;
  /** Shows a spinner in place of the label so a slow retry does not read as an ignored tap. */
  retrying?: boolean;
}) {
  return (
    <View testID={testID} style={styles.block}>
      <Text style={styles.title}>{title}</Text>
      {body ? <Text style={styles.body}>{body}</Text> : null}
      <Pressable
        testID={`${testID}-retry`}
        onPress={onRetry}
        disabled={retrying}
        accessibilityRole="button"
        accessibilityLabel={`${title}. Tap to try again.`}
        accessibilityState={{ disabled: Boolean(retrying), busy: Boolean(retrying) }}
        style={[styles.button, retrying && styles.buttonBusy]}
      >
        {retrying ? (
          <ActivityIndicator color={theme.color.brandRed} />
        ) : (
          <Text style={styles.buttonText}>Try again</Text>
        )}
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  block: {
    borderRadius: theme.radius.md,
    borderWidth: 1,
    borderColor: theme.color.border,
    backgroundColor: theme.color.surfaceMuted,
    padding: theme.space.lg,
    gap: theme.space.sm,
    alignItems: "flex-start",
  },
  title: { fontFamily: theme.font.semibold, fontSize: 15, color: theme.color.textPrimary },
  body: { fontFamily: theme.font.regular, fontSize: 13, color: theme.color.textSecondary },
  button: {
    marginTop: theme.space.xs,
    minHeight: 44,
    justifyContent: "center",
    paddingHorizontal: theme.space.lg,
    borderRadius: theme.radius.sm,
    borderWidth: 1,
    borderColor: theme.color.brandRed,
  },
  buttonBusy: { opacity: 0.6 },
  buttonText: { fontFamily: theme.font.semibold, fontSize: 14, color: theme.color.brandRed },
});
