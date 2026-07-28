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
 * the inverted mark.
 *
 * THE PROP NAMES THE SURFACE, and defaults to `dark`. It used to be a `tint` that took "dark" | "light"
 * and meant the opposite of what it read like — `tint="light"` selected the on-DARK artwork — with a
 * default that quietly assumed a light app. When the app went dark, every header kept rendering the
 * on-light mark: the exact "silently render a broken logo" this note warned about, produced by the
 * safeguard's own default. A prop that describes what it sits ON cannot be read backwards.
 *
 * expo-image, never React Native's <Image> — see the tree-wide guard in src/__tests__. Core <Image> has
 * a Fabric use-after-free that crashed the other app in production.
 */
export function BrandLogo({
  size = 28,
  showWordmark = true,
  surface = "dark",
}: {
  size?: number;
  showWordmark?: boolean;
  /** The surface this logo sits on — NOT the colour of the logo. */
  surface?: "dark" | "light";
}) {
  const onDarkSurface = surface === "dark";
  return (
    // ONE accessibility element. Left as two, a screen reader announces the mark and then the word
    // "CRM" as separate stops — noise on every screen, since this sits in the header of all of them.
    <View style={styles.row} accessible accessibilityRole="image" accessibilityLabel="T-Rock CRM">
      <ExpoImage
        source={onDarkSurface ? require("../../assets/mark.png") : require("../../assets/mark-onlight.png")}
        style={{ width: size, height: size }}
        contentFit="contain"
        // A bundled asset, but still keyed: recycling a mark across a tint change would show the wrong
        // variant for a frame.
        recyclingKey={onDarkSurface ? "mark-dark" : "mark-light"}
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
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
