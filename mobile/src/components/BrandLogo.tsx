import React from "react";
import { Image, StyleSheet, Text, View } from "react-native";
import { theme } from "../theme/theme";

/**
 * T Rock brand mark + optional "T-ROCK CAM" wordmark. Mirrors client-field
 * BrandLogo (logo + responsive sizing on a configurable surface).
 *
 * The mark ships in two surface variants. The source artwork (mark.png) is the
 * monogram designed for a DARK surface — a red "T" with a WHITE "R" + accents,
 * matching the app icon. On a LIGHT surface those white parts collapse into a
 * gray ghost, so light surfaces use mark-onlight.png, where the white elements
 * are the brand charcoal (the natural light-surface inversion). `tint` already
 * encodes the surface ("light" text ⇒ dark surface), so it also selects the mark.
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
  const onDarkSurface = tint === "light";
  const textColor = onDarkSurface ? theme.color.textInverse : theme.color.textPrimary;
  const markSource = onDarkSurface
    ? require("../../assets/mark.png")
    : require("../../assets/mark-onlight.png");
  return (
    <View style={styles.row}>
      <Image
        source={markSource}
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
