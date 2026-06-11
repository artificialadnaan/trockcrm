import React from "react";
import { StyleSheet, Text, View } from "react-native";
import { theme } from "../theme/theme";

export function Banner({ message, tone = "error" }: { message: string; tone?: "error" | "info" | "success" }) {
  const palette =
    tone === "error"
      ? { bg: "#FDECEC", border: theme.color.danger, text: theme.color.brandRedDark }
      : tone === "success"
        ? { bg: "#E9F7EF", border: theme.color.success, text: "#15803D" }
        : { bg: theme.color.surfaceMuted, border: theme.color.border, text: theme.color.textMuted };
  return (
    <View style={[styles.banner, { backgroundColor: palette.bg, borderColor: palette.border }]} accessibilityRole="alert">
      <Text style={[styles.text, { color: palette.text }]}>{message}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  banner: {
    borderWidth: 1,
    borderRadius: theme.radius.md,
    paddingHorizontal: theme.space.md,
    paddingVertical: theme.space.sm,
  },
  text: { fontFamily: theme.font.medium, fontSize: 14 },
});
