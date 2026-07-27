import React from "react";
import { StyleSheet, Text, View } from "react-native";
import { theme } from "../theme/theme";
import { BrandLogo } from "./BrandLogo";

/**
 * The header every top-level screen wears.
 *
 * Exists because the app read as a set of unrelated screens: each one rendered its own bare title in its
 * own spacing, with no brand anywhere after the login screen. One header component is what makes them
 * feel like one product — and, being shared, it cannot drift between surfaces the way three hand-rolled
 * titles would.
 *
 * `context` carries the office NAME. It used to render the office UUID, which is an internal identifier
 * no one can act on: it tells a user in two offices nothing about which one they are looking at.
 */
export function ScreenHeader({
  title,
  context,
  right,
}: {
  title: string;
  context?: string | null;
  right?: React.ReactNode;
}) {
  return (
    <View style={styles.wrap}>
      <View style={styles.brandRow}>
        <BrandLogo size={22} />
        {context ? <Text style={styles.context}>{context}</Text> : null}
      </View>
      <View style={styles.titleRow}>
        <Text style={styles.title}>{title}</Text>
        {right}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    paddingHorizontal: theme.space.lg,
    paddingTop: theme.space.sm,
    paddingBottom: theme.space.sm,
    backgroundColor: theme.color.surface,
    borderBottomWidth: 1,
    borderBottomColor: theme.color.borderSubtle,
  },
  brandRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  context: { fontFamily: theme.font.semibold, fontSize: 12, color: theme.color.textMuted },
  titleRow: {
    flexDirection: "row",
    alignItems: "baseline",
    justifyContent: "space-between",
    marginTop: theme.space.xs,
  },
  title: { fontFamily: theme.font.bold, fontSize: 26, color: theme.color.inkNavy },
});
