import React from "react";
import { Image, StyleSheet, Text, View } from "react-native";
import { theme } from "../theme/theme";

/**
 * T Rock brand mark + optional "T-ROCK CAM" wordmark. Mirrors client-field
 * BrandLogo (logo + responsive sizing on a configurable surface).
 */
export function BrandLogo({
  size = 64,
  showWordmark = true,
  tint = "dark",
}: {
  size?: number;
  showWordmark?: boolean;
  tint?: "dark" | "light";
}) {
  const textColor = tint === "light" ? theme.color.textInverse : theme.color.textPrimary;
  return (
    <View style={styles.row}>
      <Image
        source={require("../../assets/mark.png")}
        style={{ width: size, height: size }}
        resizeMode="contain"
        accessibilityLabel="T Rock"
      />
      {showWordmark ? (
        <View>
          <Text style={[styles.word, { color: textColor }]}>T-ROCK</Text>
          <Text style={[styles.sub, { color: theme.color.brandRed }]}>CAM</Text>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: "row", alignItems: "center", gap: theme.space.sm },
  word: { fontFamily: theme.font.bold, fontSize: 20, letterSpacing: 1, lineHeight: 22 },
  sub: { fontFamily: theme.font.bold, fontSize: 14, letterSpacing: 4, lineHeight: 16 },
});
