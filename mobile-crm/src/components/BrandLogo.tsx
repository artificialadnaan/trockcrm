import React from "react";
import { Image as ExpoImage } from "expo-image";
import { StyleSheet, Text, View } from "react-native";
import { theme } from "../theme/theme";

/**
 * The T-Rock mark, with an optional "CRM" wordmark.
 *
 * This is the COMPANY mark, shared with T-Rock Cam and the web app — not that app's identity. Reusing it
 * is correct and is what makes the two apps read as one product family. (The app ICON is a separate
 * question: two T-Rock apps sharing a home-screen icon would be indistinguishable, so that one still
 * wants its own treatment.)
 *
 * Two surface variants ship because the source artwork is a monogram designed for a DARK surface — red
 * "T", white "R". On a light surface those white parts collapse into a gray ghost, so light surfaces use
 * the inverted mark. This app is light throughout, but the variant is selectable so a future dark header
 * does not silently render a broken logo.
 *
 * expo-image, never React Native's <Image> — see the tree-wide guard in src/__tests__. Core <Image> has
 * a Fabric use-after-free that crashed the other app in production.
 */
export function BrandLogo({
  size = 28,
  showWordmark = true,
  tint = "dark",
}: {
  size?: number;
  showWordmark?: boolean;
  tint?: "dark" | "light";
}) {
  const onDarkSurface = tint === "light";
  return (
    <View style={styles.row}>
      <ExpoImage
        source={onDarkSurface ? require("../../assets/mark.png") : require("../../assets/mark-onlight.png")}
        style={{ width: size, height: size }}
        contentFit="contain"
        // A bundled asset, but still keyed: recycling a mark across a tint change would show the wrong
        // variant for a frame.
        recyclingKey={onDarkSurface ? "mark-dark" : "mark-light"}
        accessibilityLabel="T-Rock"
      />
      {showWordmark ? (
        <Text
          style={[
            styles.wordmark,
            { color: onDarkSurface ? theme.color.textInverse : theme.color.inkNavy },
          ]}
        >
          CRM
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: "row", alignItems: "center", gap: theme.space.sm },
  wordmark: { fontFamily: theme.font.bold, fontSize: 16, letterSpacing: 1.5 },
});
