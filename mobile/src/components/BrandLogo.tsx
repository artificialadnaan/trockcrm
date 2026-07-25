import React from "react";
import { StyleSheet, Text, View } from "react-native";
import { Image as ExpoImage } from "expo-image";
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
    // Group the mark + wordmark into a single VoiceOver element so the logo
    // announces once ("T-Rock Cam"), not three times (mark, "T-ROCK", "CAM").
    <View style={styles.row} accessible accessibilityRole="image" accessibilityLabel="T-Rock Cam">
      {/*
        expo-image, not core <Image>, even though this is a bundled require() asset. A bundled asset is
        NOT loaded synchronously on Fabric: RCTImageManager::requestImage dispatch_asyncs every request
        onto its background serial queue, and RCTBundleAssetImageLoader still fires progressHandler(1,1)
        from there — so it reaches ImageResponseObserverCoordinator::nativeImageResponseProgress, which
        snapshots observers_ under the mutex and then dereferences those RAW pointers after unlocking.
        ScreenHeader mounts this logo on the capture and tab screens, so it unmounts on every navigation
        — a narrow window against that race, but the same one, on nearly every screen in the app.
      */}
      <ExpoImage
        testID="brand-logo-mark"
        source={markSource}
        style={{ width: size, height: size }}
        contentFit="contain"
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
