import React, { useRef, useState } from "react";
import { Image, Modal, Pressable, ScrollView, Share, StyleSheet, Text, View, useWindowDimensions } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useAuth } from "../auth/AuthContext";
import { shareProjectPhotos } from "../api/endpoints";
import type { FieldPhoto } from "../api/types";
import { buildShareMessage } from "../projects/share-message";
import { theme } from "../theme/theme";
import { Button, SectionLabel } from "./ui";
import { Banner } from "./Banner";

// Mirror the server cap (server/src/modules/field/routes.ts MAX_SHARE_PHOTOS) so a large gallery can't
// post 201+ ids and get a 400 — we cap the selection client-side and tell the user.
const MAX_SHARE_PHOTOS = 200;

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
  // A successfully-minted link kept ONLY when the OS share sheet itself failed, so the user can retry
  // (re-open the same link, no re-mint) or copy the surfaced URL. Cleared whenever the selection
  // changes so a retry can never share a link for a selection the user has since edited.
  const [retryLink, setRetryLink] = useState<{ url: string; photoCount: number } | null>(null);
  // Monotonic id so a share that's in-flight when the user closes/cancels (or reopens) detects it's
  // been superseded and bails before opening the sheet or firing onShared.
  const runIdRef = useRef(0);

  function reset() {
    setSelected(new Set());
    setBusy(false);
    setError(null);
    setRetryLink(null);
  }

  function close() {
    runIdRef.current += 1; // invalidate any in-flight share so it can't act after the picker closes
    reset();
    onClose();
  }

  // Any selection change invalidates a pending retry link (it was minted for the old set) and clears
  // the stale error banner.
  function clearStaleShare() {
    setError(null);
    setRetryLink(null);
  }

  function toggle(id: string) {
    clearStaleShare();
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        if (next.size >= MAX_SHARE_PHOTOS) return prev; // cap reached — ignore further selections
        next.add(id);
      }
      return next;
    });
  }

  const selectableCount = Math.min(photos.length, MAX_SHARE_PHOTOS);
  const allSelected = selected.size === selectableCount && selectableCount > 0;
  function toggleAll() {
    clearStaleShare();
    setSelected(allSelected ? new Set() : new Set(photos.slice(0, MAX_SHARE_PHOTOS).map((p) => p.id)));
  }

  // Opens the OS share sheet for an already-minted link. Resolves true if shared, false if dismissed;
  // throws only if the sheet itself fails to present.
  async function openShareSheet(url: string, photoCount: number): Promise<boolean> {
    const result = await Share.share({ message: buildShareMessage(url, photoCount), url });
    return result.action !== Share.dismissedAction;
  }

  async function runShare() {
    if (selected.size === 0 || busy) return;
    const myRun = (runIdRef.current += 1);
    const isCurrent = () => runIdRef.current === myRun;
    setError(null);
    setRetryLink(null);
    setBusy(true);
    try {
      const result = await shareProjectPhotos(fetcher, projectId, { photoIds: Array.from(selected) });
      if (!isCurrent()) return; // cancelled during the POST — drop the result silently
      let shared: boolean;
      try {
        shared = await openShareSheet(result.url, result.photoCount);
      } catch {
        if (!isCurrent()) return;
        // Link minted but the sheet failed — keep it so the user can retry OR copy the surfaced URL.
        setRetryLink({ url: result.url, photoCount: result.photoCount });
        setError("Couldn't open the share sheet. Copy the link below or try again.");
        setBusy(false);
        return;
      }
      if (!isCurrent()) return;
      if (!shared) {
        setBusy(false); // user dismissed the sheet
        return;
      }
      onShared?.(result.photoCount);
      close();
    } catch (e) {
      if (!isCurrent()) return;
      setError(e instanceof Error ? e.message : "Couldn't create the share link.");
      setBusy(false);
    }
  }

  async function runRetry() {
    if (!retryLink) return;
    const myRun = (runIdRef.current += 1);
    const isCurrent = () => runIdRef.current === myRun;
    try {
      const shared = await openShareSheet(retryLink.url, retryLink.photoCount);
      if (!isCurrent()) return;
      if (!shared) return; // dismissed again — leave the retry banner up
      onShared?.(retryLink.photoCount);
      close();
    } catch {
      /* still failing — leave the retry banner + copyable URL for another attempt */
    }
  }

  const atCap = selected.size >= MAX_SHARE_PHOTOS;

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
          <View style={{ paddingHorizontal: theme.space.lg, gap: theme.space.xs }}>
            <Banner message={error} action={retryLink ? { label: "Try again", onPress: runRetry } : undefined} />
            {retryLink ? (
              <Text selectable style={styles.urlText}>
                {retryLink.url}
              </Text>
            ) : null}
          </View>
        ) : null}

        <ScrollView contentContainerStyle={styles.body}>
          <View style={styles.rowBetween}>
            <SectionLabel>{selected.size} selected{atCap ? ` · max ${MAX_SHARE_PHOTOS}` : ""}</SectionLabel>
            <Pressable onPress={toggleAll} hitSlop={8}>
              <Text style={styles.link}>{allSelected ? "Clear all" : "Select all"}</Text>
            </Pressable>
          </View>
          <Text style={styles.hint}>
            Anyone with the link can view the selected photos for 7 days — no login needed.
            {photos.length > MAX_SHARE_PHOTOS ? ` Up to ${MAX_SHARE_PHOTOS} per link.` : ""}
          </Text>
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
  urlText: { fontFamily: theme.font.body, fontSize: 12, color: theme.color.textMuted },
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
