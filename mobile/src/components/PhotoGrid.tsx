import React from "react";
import { Image, Pressable, StyleSheet, View, useWindowDimensions } from "react-native";
import type { FieldPhoto } from "../api/types";
import { theme } from "../theme/theme";

const GAP = 4;
const COLUMNS = 3;
const H_PADDING = theme.space.lg;

/** Square 3-column thumbnail grid (the project gallery body). */
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
      {photos.map((photo) => (
        <Pressable
          key={photo.id}
          onPress={() => onPress(photo)}
          accessibilityRole="imagebutton"
          accessibilityLabel={photo.displayName}
          style={{ width: size, height: size }}
        >
          {photo.imageUrl ? (
            <Image source={{ uri: photo.imageUrl }} style={styles.image} resizeMode="cover" />
          ) : (
            <View style={[styles.image, styles.placeholder]} />
          )}
        </Pressable>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  grid: { flexDirection: "row", flexWrap: "wrap", gap: GAP },
  image: { width: "100%", height: "100%", borderRadius: theme.radius.sm, backgroundColor: theme.color.surfaceMuted },
  placeholder: { borderWidth: 1, borderColor: theme.color.border },
});
