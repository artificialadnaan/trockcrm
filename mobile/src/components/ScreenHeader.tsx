import React from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { theme } from "../theme/theme";
import { BrandLogo } from "./BrandLogo";

/**
 * The one header band shared across every screen, so the top of the app is
 * consistent (same height, border, and surface everywhere). Tab screens render
 * the left-aligned brand mark; a pushed screen passes `onBack` + `title` to get a
 * back chevron and the screen title in the same band. `right` is an optional
 * trailing action node.
 */
export function ScreenHeader({
  title,
  onBack,
  right,
}: {
  title?: string;
  onBack?: () => void;
  right?: React.ReactNode;
}) {
  return (
    <View style={styles.band}>
      <View style={styles.left}>
        {onBack ? (
          <>
            <Pressable
              onPress={onBack}
              hitSlop={12}
              accessibilityRole="button"
              accessibilityLabel="Back"
              style={styles.back}
            >
              <Ionicons name="chevron-back" size={26} color={theme.color.brandRed} />
            </Pressable>
            {title ? (
              <Text style={styles.title} numberOfLines={1}>
                {title}
              </Text>
            ) : null}
          </>
        ) : (
          <BrandLogo size={32} />
        )}
      </View>
      {right ? <View style={styles.right}>{right}</View> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  band: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.space.sm,
    minHeight: 52,
    paddingHorizontal: theme.space.lg,
    paddingVertical: theme.space.sm,
    borderBottomWidth: 1,
    borderBottomColor: theme.color.border,
    backgroundColor: theme.color.surfaceCard,
  },
  // flex + minWidth:0 lets a long detail title truncate instead of pushing `right` off-screen.
  left: { flex: 1, minWidth: 0, flexDirection: "row", alignItems: "center", gap: theme.space.xs },
  back: { marginLeft: -6, padding: 2 },
  title: { flex: 1, fontFamily: theme.font.bold, fontSize: 18, color: theme.color.textPrimary },
  right: { flexShrink: 0 },
});
