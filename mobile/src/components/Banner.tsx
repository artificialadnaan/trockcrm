import React from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { theme } from "../theme/theme";

export function Banner({
  message,
  tone = "error",
  action,
}: {
  message: string;
  tone?: "error" | "info" | "success";
  action?: { label: string; onPress: () => void };
}) {
  const palette =
    tone === "error"
      ? { bg: "#FDECEC", border: theme.color.danger, text: theme.color.brandRedDark }
      : tone === "success"
        ? { bg: "#E9F7EF", border: theme.color.success, text: "#15803D" }
        : { bg: theme.color.surfaceMuted, border: theme.color.border, text: theme.color.textMuted };
  return (
    <View style={[styles.banner, { backgroundColor: palette.bg, borderColor: palette.border }]} accessibilityRole="alert">
      <Text style={[styles.text, { color: palette.text }, action && styles.textFlex]}>{message}</Text>
      {action ? (
        <Pressable onPress={action.onPress} hitSlop={8} accessibilityRole="button" accessibilityLabel={action.label}>
          <Text style={[styles.action, { color: palette.text }]}>{action.label}</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  banner: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.space.md,
    borderWidth: 1,
    borderRadius: theme.radius.md,
    paddingHorizontal: theme.space.md,
    paddingVertical: theme.space.sm,
  },
  text: { fontFamily: theme.font.medium, fontSize: 14 },
  textFlex: { flex: 1 },
  action: { fontFamily: theme.font.bold, fontSize: 14, textDecorationLine: "underline" },
});
