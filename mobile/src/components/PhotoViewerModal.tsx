import React, { useCallback, useRef, useState } from "react";
import {
  FlatList,
  Image,
  Modal,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
} from "react-native";
import { SafeAreaProvider, SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import type { FieldPhoto } from "../api/types";
import { categoryLabel } from "../projects/field-projects";
import { theme } from "../theme/theme";

const ADDRESS_SOURCE_LABEL: Record<string, string> = {
  exif: "From photo",
  live_gps: "Captured at upload",
  deal_fallback: "Project address",
  manual_override: "Manually set",
};

function formatTimestamp(photo: FieldPhoto): string {
  const value = photo.takenAt ?? photo.createdAt;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

/** Full-screen swipeable viewer with the per-photo detail panel. */
export function PhotoViewerModal({
  photos,
  initialIndex,
  visible,
  onClose,
}: {
  photos: FieldPhoto[];
  initialIndex: number;
  visible: boolean;
  onClose: () => void;
}) {
  const { width, height } = useWindowDimensions();
  const [index, setIndex] = useState(initialIndex);
  const listRef = useRef<FlatList<FieldPhoto>>(null);

  const onScrollEnd = useCallback(
    (e: NativeSyntheticEvent<NativeScrollEvent>) => {
      const next = Math.round(e.nativeEvent.contentOffset.x / width);
      if (next !== index) setIndex(next);
    },
    [index, width],
  );

  // Clamp defensively so the header/detail panel can never index out of range.
  const safeIndex = photos.length > 0 ? Math.min(Math.max(index, 0), photos.length - 1) : 0;
  const current = photos[safeIndex];

  // Visible prev/next chevrons advertise navigation (the pager is otherwise swipe-only).
  const goTo = useCallback(
    (next: number) => {
      if (next < 0 || next >= photos.length) return;
      setIndex(next);
      listRef.current?.scrollToIndex({ index: next, animated: true });
    },
    [photos.length],
  );

  return (
    <Modal visible={visible} animationType="fade" onRequestClose={onClose} transparent={false}>
      {/* A fullScreen Modal renders in its own native window outside the app's SafeAreaProvider,
          so the viewer's SafeAreaView needs its own provider to resolve real insets — otherwise
          the Close button / counter land under the Dynamic Island and the detail panel runs under
          the home indicator. (Matches the CameraCapture / ReviewTray pattern.) */}
      <SafeAreaProvider>
      <View style={styles.backdrop}>
        <SafeAreaView style={styles.safe} edges={["top", "bottom"]}>
          <View style={styles.topBar}>
            <Text style={styles.counter}>
              {photos.length ? `${safeIndex + 1} / ${photos.length}` : ""}
            </Text>
            <Pressable onPress={onClose} hitSlop={12} accessibilityLabel="Close viewer">
              <Text style={styles.close}>Close</Text>
            </Pressable>
          </View>

          <View style={[styles.pager, { height: height * 0.58 }]}>
            <FlatList
              ref={listRef}
              data={photos}
              keyExtractor={(p) => p.id}
              horizontal
              pagingEnabled
              showsHorizontalScrollIndicator={false}
              initialScrollIndex={initialIndex}
              getItemLayout={(_, i) => ({ length: width, offset: width * i, index: i })}
              onMomentumScrollEnd={onScrollEnd}
              renderItem={({ item }) => (
                <View style={{ width, height: height * 0.58, alignItems: "center", justifyContent: "center" }}>
                  {item.imageUrl ? (
                    <Image source={{ uri: item.imageUrl }} style={{ width, height: "100%" }} resizeMode="contain" />
                  ) : (
                    <Text style={styles.noImage}>Image unavailable</Text>
                  )}
                </View>
              )}
            />
            {safeIndex > 0 ? (
              <Pressable
                style={[styles.chevron, styles.chevronLeft]}
                onPress={() => goTo(safeIndex - 1)}
                hitSlop={8}
                accessibilityRole="button"
                accessibilityLabel="Previous photo"
              >
                <Ionicons name="chevron-back" size={28} color={theme.color.textInverse} />
              </Pressable>
            ) : null}
            {safeIndex < photos.length - 1 ? (
              <Pressable
                style={[styles.chevron, styles.chevronRight]}
                onPress={() => goTo(safeIndex + 1)}
                hitSlop={8}
                accessibilityRole="button"
                accessibilityLabel="Next photo"
              >
                <Ionicons name="chevron-forward" size={28} color={theme.color.textInverse} />
              </Pressable>
            ) : null}
          </View>

          {current ? (
            <ScrollView style={styles.details} contentContainerStyle={{ padding: theme.space.lg, gap: 8 }}>
              <Text style={styles.detailTitle} numberOfLines={2}>
                {current.displayName}
              </Text>
              <DetailRow label="Category" value={categoryLabel(current.photoCategory ?? current.subcategory)} />
              {current.description ? <DetailRow label="Description" value={current.description} /> : null}
              <DetailRow label="Uploaded by" value={current.uploaderName || "Unknown"} />
              <DetailRow label="Captured" value={formatTimestamp(current)} />
              {current.address ? <DetailRow label="Location" value={current.address} /> : null}
              {current.addressSource ? (
                <DetailRow label="Source" value={ADDRESS_SOURCE_LABEL[current.addressSource] ?? "No source"} />
              ) : null}
              {current.procoreSyncStatus ? (
                <DetailRow label="Procore" value={current.procoreSyncStatus} />
              ) : null}
              {current.tags && current.tags.length > 0 ? (
                <DetailRow label="Tags" value={current.tags.join(", ")} />
              ) : null}
            </ScrollView>
          ) : null}
        </SafeAreaView>
      </View>
      </SafeAreaProvider>
    </Modal>
  );
}

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.detailRow}>
      <Text style={styles.detailLabel}>{label}</Text>
      <Text style={styles.detailValue}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: theme.color.brandBlack },
  safe: { flex: 1 },
  topBar: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: theme.space.lg,
    paddingVertical: theme.space.sm,
  },
  counter: { color: theme.color.textInverse, fontFamily: theme.font.medium, fontSize: 14 },
  close: { color: theme.color.textInverse, fontFamily: theme.font.semibold, fontSize: 16 },
  noImage: { color: theme.color.textInverse, fontFamily: theme.font.body },
  pager: { position: "relative", justifyContent: "center" },
  chevron: {
    position: "absolute",
    top: "50%",
    marginTop: -22,
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: "rgba(0,0,0,0.45)",
    alignItems: "center",
    justifyContent: "center",
  },
  chevronLeft: { left: theme.space.sm },
  chevronRight: { right: theme.space.sm },
  details: {
    flex: 1,
    backgroundColor: theme.color.surfaceCard,
    borderTopLeftRadius: theme.radius.lg,
    borderTopRightRadius: theme.radius.lg,
  },
  detailTitle: { fontFamily: theme.font.bold, fontSize: 18, color: theme.color.textPrimary },
  detailRow: { flexDirection: "row", gap: theme.space.md },
  detailLabel: { fontFamily: theme.font.semibold, fontSize: 13, color: theme.color.textMuted, width: 96 },
  detailValue: { fontFamily: theme.font.body, fontSize: 14, color: theme.color.textPrimary, flex: 1 },
});
