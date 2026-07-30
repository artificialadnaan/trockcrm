import React from "react";
import { Pressable, StyleSheet, Text, View, useWindowDimensions } from "react-native";
import { Image as ExpoImage } from "expo-image";
import type { FieldPhoto } from "../api/types";
import { categoryLabel } from "../projects/field-projects";
import { thumbnailCacheKey } from "../photos/cache-keys";
import { theme } from "../theme/theme";

const GAP = 4;
export const PHOTO_GRID_COLUMNS = 3;
const H_PADDING = theme.space.lg;

/** Edge length of one square thumbnail, so a virtualized caller can size its rows exactly as the grid does. */
export function usePhotoTileSize(): number {
  const { width } = useWindowDimensions();
  return Math.floor((width - H_PADDING * 2 - GAP * (PHOTO_GRID_COLUMNS - 1)) / PHOTO_GRID_COLUMNS);
}

/**
 * One square thumbnail. Mirrors the field web gallery: a category badge overlay and a one-line caption
 * (the photo's description, falling back to the uploader) beneath it.
 */
function PhotoTile({
  photo,
  size,
  onPress,
}: {
  photo: FieldPhoto;
  size: number;
  onPress: (photo: FieldPhoto) => void;
}) {
  const caption = photo.description || photo.uploaderName;
  return (
    <View style={{ width: size }}>
      <Pressable
        onPress={() => onPress(photo)}
        accessibilityRole="imagebutton"
        accessibilityLabel={photo.displayName}
        style={[styles.thumb, { height: size }]}
      >
        {photo.imageUrl ? (
          <ExpoImage
            testID={`photo-grid-image-${photo.id}`}
            // Keyed on the photo id, not the presigned URL: the signature changes on every list refetch,
            // so a URL-keyed cache misses every time and re-downloads a thumbnail it already has. The key
            // is shared with the viewer, whose placeholder reads THIS entry — see photos/cache-keys.
            source={{ uri: photo.imageUrl, cacheKey: thumbnailCacheKey(photo.id) }}
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
}

/**
 * ONE row of up to PHOTO_GRID_COLUMNS thumbnails — the unit a virtualized gallery renders.
 *
 * A project can hold thousands of photos, and the plain grid below mounts a native image view for every
 * one of them, with cachePolicy="memory-disk" retaining each decoded tile for as long as the screen is
 * open. Rendering a row at a time lets the list unmount what has scrolled away.
 */
export function PhotoGridRow({
  photos,
  size,
  onPress,
}: {
  photos: FieldPhoto[];
  size: number;
  onPress: (photo: FieldPhoto) => void;
}) {
  return (
    <View style={styles.row}>
      {photos.map((photo) => (
        <PhotoTile key={photo.id} photo={photo} size={size} onPress={onPress} />
      ))}
    </View>
  );
}

/**
 * Square 3-column thumbnail grid, NOT virtualized — every photo mounts at once. Fine for a bounded set;
 * for a whole project gallery render PhotoGridRow inside a list instead.
 */
export function PhotoGrid({
  photos,
  onPress,
}: {
  photos: FieldPhoto[];
  onPress: (photo: FieldPhoto) => void;
}) {
  const size = usePhotoTileSize();
  return (
    <View style={styles.grid}>
      {photos.map((photo) => (
        <PhotoTile key={photo.id} photo={photo} size={size} onPress={onPress} />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  grid: { flexDirection: "row", flexWrap: "wrap", gap: GAP },
  row: { flexDirection: "row", gap: GAP },
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
