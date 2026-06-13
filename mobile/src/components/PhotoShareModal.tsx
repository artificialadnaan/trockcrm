import React, { useState } from "react";
import { Image, Modal, Pressable, ScrollView, Share, StyleSheet, Text, View, useWindowDimensions } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useAuth } from "../auth/AuthContext";
import { shareProjectPhotos } from "../api/endpoints";
import type { FieldPhoto } from "../api/types";
import { buildShareMessage } from "../projects/share-message";
import { theme } from "../theme/theme";
import { Button, SectionLabel } from "./ui";
import { Banner } from "./Banner";

/**
 * Photo-share flow (mirrors the ReportBuilder select grid): multi-select a project's photos →
 * "Share link" → POST /field/projects/:id/share → open the iOS share sheet with the returned URL.
 * Photos-only: the endpoint mints a public, 7-day, read-only link and never mutates the deal.
 */
export function PhotoShareModal({
  visible,
  onClose,
  projectId,
  photos,
  onShared,
}: {
  visible: boolean;
  onClose: () => void;
  projectId: string;
  photos: FieldPhoto[];
  onShared?: (photoCount: number) => void;
}) {
  const { fetcher } = useAuth();
  const { width } = useWindowDimensions();
  const cell = Math.floor((width - theme.space.lg * 2 - 8 * 2) / 3);

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function reset() {
    setSelected(new Set());
    setBusy(false);
    setError(null);
  }

  function close() {
    reset();
    onClose();
  }

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  const allSelected = selected.size === photos.length && photos.length > 0;
  function toggleAll() {
    setSelected(allSelected ? new Set() : new Set(photos.map((p) => p.id)));
  }

  async function runShare() {
    if (selected.size === 0 || busy) return;
    setError(null);
    setBusy(true);
    try {
      const result = await shareProjectPhotos(fetcher, projectId, { photoIds: Array.from(selected) });
      // Link is created. Open the OS share sheet; if that fails, surface the URL so it isn't lost.
      try {
        const shareResult = await Share.share({ message: buildShareMessage(result.url, result.photoCount), url: result.url });
        // User cancelled the sheet — the link exists, but don't claim success or close the picker.
        if (shareResult.action === Share.dismissedAction) {
          setBusy(false);
          return;
        }
      } catch {
        setError(`Link created — copy it to share: ${result.url}`);
        setBusy(false);
        return;
      }
      onShared?.(result.photoCount);
      close();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't create the share link.");
      setBusy(false);
    }
  }

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={close} presentationStyle="pageSheet">
      <SafeAreaView style={styles.container} edges={["top", "bottom"]}>
        <View style={styles.header}>
          <Pressable onPress={close} hitSlop={10}>
            <Text style={styles.headerAction}>Cancel</Text>
          </Pressable>
          <Text style={styles.headerTitle}>Share photos</Text>
          <View style={{ width: 56 }} />
        </View>

        {error ? (
          <View style={{ paddingHorizontal: theme.space.lg }}>
            <Banner message={error} />
          </View>
        ) : null}

        <ScrollView contentContainerStyle={styles.body}>
          <View style={styles.rowBetween}>
            <SectionLabel>{selected.size} selected</SectionLabel>
            <Pressable onPress={toggleAll} hitSlop={8}>
              <Text style={styles.link}>{allSelected ? "Clear all" : "Select all"}</Text>
            </Pressable>
          </View>
          <Text style={styles.hint}>Anyone with the link can view the selected photos for 7 days — no login needed.</Text>
          <View style={styles.grid}>
            {photos.map((photo) => {
              const isSelected = selected.has(photo.id);
              return (
                <Pressable
                  key={photo.id}
                  onPress={() => toggle(photo.id)}
                  style={{ width: cell, height: cell }}
                  accessibilityRole="button"
                  accessibilityState={{ selected: isSelected }}
                  accessibilityLabel={`${isSelected ? "Selected" : "Select"} ${photo.displayName || "photo"}`}
                >
                  {photo.imageUrl ? (
                    <Image source={{ uri: photo.imageUrl }} style={styles.thumb} resizeMode="cover" />
                  ) : (
                    <View style={[styles.thumb, styles.placeholder]} />
                  )}
                  {isSelected ? (
                    <View style={styles.check}>
                      <Text style={styles.checkMark}>✓</Text>
                    </View>
                  ) : null}
                </Pressable>
              );
            })}
          </View>
        </ScrollView>

        <View style={styles.footer}>
          <Button
            title={selected.size > 0 ? `Share link (${selected.size})` : "Share link"}
            onPress={runShare}
            loading={busy}
            disabled={selected.size === 0}
          />
        </View>
      </SafeAreaView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: theme.color.surfaceApp },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: theme.space.lg,
    paddingVertical: theme.space.md,
  },
  headerTitle: { fontFamily: theme.font.bold, fontSize: 18, color: theme.color.textPrimary },
  headerAction: { fontFamily: theme.font.semibold, fontSize: 16, color: theme.color.brandRed, width: 56 },
  body: { padding: theme.space.lg, gap: theme.space.md, paddingBottom: theme.space.xxl },
  rowBetween: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  link: { fontFamily: theme.font.semibold, fontSize: 14, color: theme.color.brandRed },
  hint: { fontFamily: theme.font.body, fontSize: 13, color: theme.color.textMuted },
  grid: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  thumb: { width: "100%", height: "100%", borderRadius: theme.radius.sm, backgroundColor: theme.color.surfaceMuted },
  placeholder: { borderWidth: 1, borderColor: theme.color.border },
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
  footer: {
    padding: theme.space.lg,
    borderTopWidth: 1,
    borderTopColor: theme.color.border,
    backgroundColor: theme.color.surfaceCard,
  },
});
