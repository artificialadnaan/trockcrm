import React from "react";
import { Pressable, StyleSheet, Text, View, useWindowDimensions } from "react-native";
import { Image as ExpoImage } from "expo-image";
import type { FieldPhoto } from "../api/types";
import { categoryLabel } from "../projects/field-projects";
import { theme } from "../theme/theme";

const GAP = 4;
const COLUMNS = 3;
const H_PADDING = theme.space.lg;

/**
 * Square 3-column thumbnail grid (the project gallery body). Mirrors the field web
 * gallery: each thumbnail carries a category badge overlay and a one-line caption
 * (the photo's description, falling back to the uploader) beneath it.
 */
export function PhotoGrid({
  photos,
  onPress,
}: {
  photos: FieldPhoto[];
  onPress: (photo: FieldPhoto) => void;
}) {
  const { width } = useWindowDimensions();
  const size = Math.floor((width - H_PADDING * 2 - GAP * (COLUMNS - 1)) / COLUMNS);
  return (
    <View style={styles.grid}>
      {photos.map((photo) => {
        const caption = photo.description || photo.uploaderName;
        return (
          <View key={photo.id} style={{ width: size }}>
            <Pressable
              onPress={() => onPress(photo)}
              accessibilityRole="imagebutton"
              accessibilityLabel={photo.displayName}
              style={[styles.thumb, { height: size }]}
            >
              {photo.imageUrl ? (
                <ExpoImage
                  testID={`photo-grid-image-${photo.id}`}
                  source={{ uri: photo.imageUrl }}
                  style={styles.image}
                  contentFit="cover"
                  recyclingKey={photo.id}
                  cachePolicy="memory-disk"
                />
              ) : (
                <View style={[styles.image, styles.placeholder]} />
              )}
              {photo.photoCategory ? (
                <View style={styles.catBadge}>
                  <Text style={styles.catBadgeText} numberOfLines={1}>
                    {categoryLabel(photo.photoCategory)}
                  </Text>
                </View>
              ) : null}
            </Pressable>
            {caption ? (
              <Text style={styles.caption} numberOfLines={1}>
                {caption}
              </Text>
            ) : null}
          </View>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  grid: { flexDirection: "row", flexWrap: "wrap", gap: GAP },
  thumb: { width: "100%", borderRadius: theme.radius.sm, overflow: "hidden", backgroundColor: theme.color.surfaceMuted },
  image: { width: "100%", height: "100%", backgroundColor: theme.color.surfaceMuted },
  placeholder: { borderWidth: 1, borderColor: theme.color.border },
  catBadge: {
    position: "absolute",
    bottom: 4,
    right: 4,
    borderRadius: theme.radius.pill,
    backgroundColor: "rgba(0,0,0,0.7)",
    paddingHorizontal: theme.space.sm,
    paddingVertical: 2,
    maxWidth: "92%",
  },
  catBadgeText: { color: theme.color.textInverse, fontSize: 10, fontFamily: theme.font.bold },
  caption: { marginTop: 4, fontSize: 12, fontFamily: theme.font.semibold, color: theme.color.textMuted },
});
