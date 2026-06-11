import React, { useState } from "react";
import { Image, Pressable, StyleSheet, Text, View, useWindowDimensions } from "react-native";
import { theme } from "../theme/theme";
import type { SessionPhoto } from "../capture/session-photo";
import { TextInput } from "./ui";

const GAP = 8;
const COLUMNS = 3;
const H_PADDING = theme.space.lg;

/**
 * Review tray: a grid of captured/imported photos. Tap a photo to caption it
 * individually (optional). A caption badge marks photos that already have their
 * own caption; the rest inherit the batch caption at upload.
 */
export function ReviewTray({
  photos,
  onSetCaption,
  onRemove,
  disabled = false,
}: {
  photos: SessionPhoto[];
  onSetCaption: (key: string, text: string) => void;
  onRemove: (key: string) => void;
  disabled?: boolean;
}) {
  const { width } = useWindowDimensions();
  const size = Math.floor((width - H_PADDING * 2 - GAP * (COLUMNS - 1)) / COLUMNS);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const selected = photos.find((p) => p.key === selectedKey) ?? null;

  return (
    <View style={{ gap: theme.space.md }}>
      <View style={styles.grid}>
        {photos.map((photo) => {
          const isSelected = photo.key === selectedKey;
          const hasCaption = photo.caption.trim().length > 0;
          return (
            <Pressable
              key={photo.key}
              onPress={() => setSelectedKey(isSelected ? null : photo.key)}
              disabled={disabled}
              style={{ width: size, height: size }}
              accessibilityLabel={hasCaption ? "Photo (captioned) — edit caption" : "Photo — add caption"}
            >
              <Image source={{ uri: photo.uri }} style={styles.thumb} />
              {hasCaption ? (
                <View style={styles.captionBadge}>
                  <Text style={styles.captionBadgeText}>✎</Text>
                </View>
              ) : null}
              {isSelected ? <View style={styles.selectedRing} /> : null}
            </Pressable>
          );
        })}
      </View>

      {selected ? (
        <View style={styles.editor}>
          <View style={styles.editorHead}>
            <Image source={{ uri: selected.uri }} style={styles.editorThumb} />
            <View style={{ flex: 1 }}>
              <Text style={styles.editorLabel}>Caption for this photo</Text>
              <Text style={styles.editorHint}>Optional — leave blank to use the batch caption.</Text>
            </View>
            <Pressable onPress={() => onRemove(selected.key)} disabled={disabled} hitSlop={8} accessibilityLabel="Remove photo">
              <Text style={styles.remove}>Remove</Text>
            </Pressable>
          </View>
          <TextInput
            value={selected.caption}
            onChangeText={(text) => onSetCaption(selected.key, text)}
            editable={!disabled}
            placeholder="Describe this photo"
            multiline
            style={{ minHeight: 64, textAlignVertical: "top", paddingTop: 10 }}
          />
        </View>
      ) : (
        <Text style={styles.tapHint}>Tap a photo to caption it (optional).</Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  grid: { flexDirection: "row", flexWrap: "wrap", gap: GAP },
  thumb: { width: "100%", height: "100%", borderRadius: theme.radius.sm, backgroundColor: theme.color.surfaceMuted },
  captionBadge: {
    position: "absolute",
    top: 4,
    left: 4,
    width: 22,
    height: 22,
    borderRadius: 11,
    backgroundColor: theme.color.brandRed,
    alignItems: "center",
    justifyContent: "center",
  },
  captionBadgeText: { color: theme.color.textInverse, fontSize: 12, fontFamily: theme.font.bold },
  selectedRing: {
    ...StyleSheet.absoluteFillObject,
    borderRadius: theme.radius.sm,
    borderWidth: 3,
    borderColor: theme.color.brandRed,
  },
  editor: {
    backgroundColor: theme.color.surfaceCard,
    borderWidth: 1,
    borderColor: theme.color.border,
    borderRadius: theme.radius.md,
    padding: theme.space.md,
    gap: theme.space.sm,
  },
  editorHead: { flexDirection: "row", alignItems: "center", gap: theme.space.md },
  editorThumb: { width: 48, height: 48, borderRadius: theme.radius.sm, backgroundColor: theme.color.surfaceMuted },
  editorLabel: { fontFamily: theme.font.semibold, fontSize: 14, color: theme.color.textPrimary },
  editorHint: { fontFamily: theme.font.body, fontSize: 12, color: theme.color.textMuted },
  remove: { fontFamily: theme.font.semibold, fontSize: 14, color: theme.color.danger },
  tapHint: { fontFamily: theme.font.body, fontSize: 13, color: theme.color.textMuted },
});
