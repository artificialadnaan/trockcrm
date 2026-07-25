import React, { useCallback } from "react";
import { FlatList, Pressable, StyleSheet, Text, View, type ListRenderItem } from "react-native";
import { Image as ExpoImage } from "expo-image";
import type { FieldPhoto } from "../api/types";
import { theme } from "../theme/theme";

const NUM_COLUMNS = 3;
const CELL_GAP = 8;

export type PhotoPickerGridProps = {
  photos: FieldPhoto[];
  /** Set of currently-selected photo ids (owned by the parent). */
  selected: Set<string>;
  onToggle: (id: string) => void;
  /** Square cell edge length in px (parent computes it from the window width). */
  cellSize: number;
  disabled?: boolean;
  /** Rendered above the grid inside the same scroll container (e.g. the "N selected / Select all" row). */
  header?: React.ReactElement | null;
  /** Rendered below the grid inside the same scroll container (e.g. the report's "Group photos" chips). */
  footer?: React.ReactElement | null;
  getAccessibilityLabel?: (photo: FieldPhoto, isSelected: boolean) => string;
};

/**
 * Virtualized, memory-safe photo picker grid shared by the report-builder and photo-share flows.
 *
 * Why this exists: both surfaces previously rendered EVERY project photo inside a `ScrollView`
 * (`photos.map` + React Native's core `<Image>`), so opening the picker on a large gallery mounted
 * hundreds of decoded bitmaps at once — slow, and OOM-crashing on big projects. This renders a `FlatList`
 * so only the visible window is mounted, and uses `expo-image` (with `recyclingKey` + a memory-disk cache)
 * so thumbnails downsample to the cell size and re-display from disk on re-open instead of re-downloading.
 * `imageUrl` is already the server-generated thumbnail (the high-res original is `fullImageUrl`).
 */
export function PhotoPickerGrid({
  photos,
  selected,
  onToggle,
  cellSize,
  disabled = false,
  header = null,
  footer = null,
  getAccessibilityLabel,
}: PhotoPickerGridProps) {
  const rowHeight = cellSize + CELL_GAP;

  const renderItem = useCallback<ListRenderItem<FieldPhoto>>(
    ({ item }) => {
      const isSelected = selected.has(item.id);
      return (
        <Pressable
          testID={`photo-cell-${item.id}`}
          onPress={() => onToggle(item.id)}
          disabled={disabled}
          style={[{ width: cellSize, height: cellSize }, disabled && styles.cellDisabled]}
          accessibilityRole="button"
          accessibilityState={{ selected: isSelected, disabled }}
          accessibilityLabel={
            getAccessibilityLabel
              ? getAccessibilityLabel(item, isSelected)
              : `${isSelected ? "Selected" : "Select"} ${item.displayName || "photo"}`
          }
        >
          {item.imageUrl ? (
            <ExpoImage
              testID={`photo-image-${item.id}`}
              source={{ uri: item.imageUrl }}
              style={styles.thumb}
              contentFit="cover"
              // Downsamples the thumbnail to the cell size and serves it from disk on re-open (no re-download).
              cachePolicy="memory-disk"
              // Resets decode state as the FlatList recycles a cell to a different photo.
              recyclingKey={item.id}
              transition={80}
            />
          ) : (
            <View style={[styles.thumb, styles.placeholder]} />
          )}
          {isSelected ? (
            <View style={styles.check} pointerEvents="none">
              <Text style={styles.checkMark}>✓</Text>
            </View>
          ) : null}
        </Pressable>
      );
    },
    [selected, onToggle, disabled, cellSize, getAccessibilityLabel],
  );

  return (
    <FlatList
      data={photos}
      keyExtractor={(item) => item.id}
      renderItem={renderItem}
      numColumns={NUM_COLUMNS}
      style={styles.list}
      columnWrapperStyle={styles.row}
      contentContainerStyle={styles.content}
      ListHeaderComponent={header}
      ListFooterComponent={footer}
      keyboardShouldPersistTaps="handled"
      // Virtualization: only the visible window mounts, so a large gallery no longer OOMs on open.
      windowSize={5}
      initialNumToRender={12}
      maxToRenderPerBatch={12}
      removeClippedSubviews
      // With numColumns, FlatList batches items into rows and calls getItemLayout with the ROW index, so
      // offset is rowHeight * index (NOT index/numColumns). Rows are equal height; the ListHeaderComponent
      // is measured separately, so these offsets are content-relative and must not include its height.
      getItemLayout={(_data, index) => ({
        length: rowHeight,
        offset: rowHeight * index,
        index,
      })}
    />
  );
}

const styles = StyleSheet.create({
  list: { flex: 1 },
  content: { padding: theme.space.lg, paddingBottom: theme.space.xxl },
  row: { gap: CELL_GAP, marginBottom: CELL_GAP },
  thumb: { width: "100%", height: "100%", borderRadius: theme.radius.sm, backgroundColor: theme.color.surfaceMuted },
  placeholder: { borderWidth: 1, borderColor: theme.color.border },
  cellDisabled: { opacity: 0.6 },
  check: {
    position: "absolute",
    top: 6,
    right: 6,
    width: 26,
    height: 26,
    borderRadius: 13,
    backgroundColor: theme.color.brandRed,
    alignItems: "center",
    justifyContent: "center",
  },
  checkMark: { color: theme.color.textInverse, fontFamily: theme.font.bold, fontSize: 14 },
});
