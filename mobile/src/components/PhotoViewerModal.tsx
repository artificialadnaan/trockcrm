import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  AccessibilityInfo,
  ActivityIndicator,
  FlatList,
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
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { Ionicons } from "@expo/vector-icons";
import type { FieldPhoto } from "../api/types";
import { categoryLabel } from "../projects/field-projects";
import { theme } from "../theme/theme";
import { ZoomablePhoto } from "./ZoomablePhoto";
import { Button, TextInput } from "./ui";
import { useUpdatePhotoMetadata } from "../query/hooks";
import { useAuth } from "../auth/AuthContext";
import { getProjectPhotos } from "../api/endpoints";
import { savePhotoToDevice } from "../photos/save-to-device";

type SaveToast = "saved" | "permission" | "error";
const SAVE_TOAST_TEXT: Record<SaveToast, string> = {
  saved: "Saved to Photos",
  permission: "Allow photo access to save",
  error: "Couldn't save photo",
};

const ADDRESS_SOURCE_LABEL: Record<string, string> = {
  exif: "From photo",
  live_gps: "Captured at upload",
  deal_fallback: "Project address",
  manual_override: "Manually set",
};

// Presigned R2 URLs on a FieldPhoto expire (PHOTO_LIST_URL_TTL_SECONDS, 6h — an earlier note here said
// ~30 min, which was the unrelated upload-PUT TTL). The viewer snapshots the photo list at open time, so
// past the TTL both the direct download AND the image load 403.
// Bound the pages we scan when re-fetching a fresh URL so a
// large deal can't spin. This ceiling MUST match the gallery's own page ceiling (useProjectPhotos'
// PHOTOS_MAX_PAGES) — the viewer can only show a photo the gallery loaded, so any photo the user is looking at
// is reachable within these pages. A smaller cap (was 5) left a photo past ~1000 (page 5 × 200) unable to
// refresh an expired URL, even though the gallery loads up to 50 pages. The scan still stops the instant it
// finds the photo, or when it passes the reported totalPages — so a small deal pays only one page.
const REFRESH_PER_PAGE = 200;
const REFRESH_MAX_PAGES = 50;

/**
 * Whether the pager's opening scroll can be issued yet.
 *
 * iOS clamps a programmatic scroll into the content width MEASURED AT CALL TIME, and RN's one-shot
 * `initialScrollIndex` scroll is fire-and-forget — no success check, no retry. Issue it before the list has
 * measured its full width (3533 photos ≈ 1.39M px) and the clamp silently truncates it, leaving the viewport
 * parked on the empty leading spacer: a black pane under a correct counter and correct metadata. So only
 * (re-)issue once the content is genuinely wide enough to hold the target offset.
 */
export function canLandInitialScroll(contentWidth: number, targetOffset: number, viewportWidth: number): boolean {
  if (targetOffset <= 0) return true; // opening on the first photo needs no scroll at all
  return contentWidth >= targetOffset + viewportWidth;
}

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
  projectDealId,
}: {
  photos: FieldPhoto[];
  initialIndex: number;
  visible: boolean;
  onClose: () => void;
  /** The deal id of the project being VIEWED. Used for cache invalidation because a source-lead photo's own
   *  dealId can be null while it still appears in this project's gallery. */
  projectDealId?: string;
}) {
  const { width, height } = useWindowDimensions();
  const { fetcher } = useAuth();
  const [index, setIndex] = useState(initialIndex);
  // When a photo is zoomed we disable the pager so a one-finger pan moves the image instead of paging.
  const [zoomed, setZoomed] = useState(false);
  const [editingOpen, setEditingOpen] = useState(false);
  const [editName, setEditName] = useState("");
  const [editDesc, setEditDesc] = useState("");
  const listRef = useRef<FlatList<FieldPhoto>>(null);
  // Guards the one re-issue of the opening scroll (see onContentSizeChange) so later content-size changes —
  // an orientation flip, say — can't yank the pager back to the photo it was opened on.
  const initialScrollLanded = useRef(false);

  // Full-res load state per photo id. expo-image renders NOTHING when a load fails, so before this the
  // viewer's only failure mode was a black rectangle with a correct-looking detail panel underneath —
  // indistinguishable from a slow decode, and impossible for a field user to report usefully.
  const [loadState, setLoadState] = useState<Record<string, "loading" | "loaded" | "error">>({});
  // Re-minted presigned URLs keyed by photo id, replacing the snapshot URL the viewer opened with.
  const [freshUrls, setFreshUrls] = useState<Record<string, string>>({});
  // Photo ids that have already spent their automatic refresh, so a genuinely broken photo can't loop.
  const refreshAttempted = useRef<Set<string>>(new Set());
  // Bumped per photo by Retry so the image can be remounted without its URL having changed.
  const [retryNonce, setRetryNonce] = useState<Record<string, number>>({});

  const onScrollEnd = useCallback(
    (e: NativeSyntheticEvent<NativeScrollEvent>) => {
      const next = Math.round(e.nativeEvent.contentOffset.x / width);
      if (next !== index) {
        setIndex(next);
        // A freshly shown photo starts at 1x — re-enable paging even if the previous one was zoomed.
        setZoomed(false);
      }
    },
    [index, width],
  );

  // The call site currently unmounts this modal between opens, so `index` starts fresh each time. That is
  // load-bearing and invisible: switch to an always-mounted `visible={...}` and `index` would stick on the
  // previously-viewed photo while initialScrollIndex moved underneath it — the detail panel describing one
  // photo while the pager shows another. Syncing here makes the component correct either way.
  //
  // Skips the mount run deliberately. useState already seeded `index`, and clearing initialScrollLanded here
  // would race the native onContentSizeChange: if that fires first (it is a layout callback, so ordering is
  // not ours to assume) it would be reset to false, and a LATER content-size change — a rotation — would
  // then re-issue the opening scroll and yank the user back to the photo they entered on.
  const initialIndexSettled = useRef(false);
  useEffect(() => {
    if (!initialIndexSettled.current) {
      initialIndexSettled.current = true;
      return;
    }
    setIndex(initialIndex);
    setZoomed(false);
    initialScrollLanded.current = false;
    // Moving `index` alone would only move the counter and the detail panel: initialScrollIndex is honored
    // at mount only, and with the same data and width no content-size change fires, so the onContentSizeChange
    // re-issue below would never run either — leaving the pager parked on the previous photo while the panel
    // describes the new one. Scroll explicitly; onScrollToIndexFailed covers a not-yet-measured list.
    listRef.current?.scrollToIndex({ index: initialIndex, animated: false });
  }, [initialIndex]);

  // Clamp defensively so the header/detail panel can never index out of range.
  const safeIndex = photos.length > 0 ? Math.min(Math.max(index, 0), photos.length - 1) : 0;
  const current = photos[safeIndex];

  // Invalidate the VIEWED project's photo cache, not the photo's own dealId (null for source-lead photos).
  const updateMeta = useUpdatePhotoMetadata(projectDealId ?? current?.dealId ?? undefined);

  const openEdit = useCallback(() => {
    if (!current) return;
    setEditName(current.displayName ?? "");
    setEditDesc(current.description ?? "");
    updateMeta.reset(); // clear any error/success from a prior edit so the sheet opens fresh
    setEditingOpen(true);
  }, [current, updateMeta]);

  const saveEdit = useCallback(() => {
    if (!current) return;
    const name = editName.trim();
    if (!name) return;
    updateMeta.mutate(
      { photoId: current.id, displayName: name, description: editDesc.trim() ? editDesc.trim() : null },
      { onSuccess: () => setEditingOpen(false) },
    );
  }, [current, editName, editDesc, updateMeta]);

  // Visible prev/next chevrons advertise navigation (the pager is otherwise swipe-only).
  const goTo = useCallback(
    (next: number) => {
      if (next < 0 || next >= photos.length) return;
      setIndex(next);
      setZoomed(false);
      listRef.current?.scrollToIndex({ index: next, animated: true });
    },
    [photos.length],
  );

  // Download a photo to the device's photo library. Explicit user action (the toolbar Save button), so it's not
  // gated on the auto-backup setting. The spinner + toast are keyed to the SAVED photo's id (not the currently
  // shown one), so swiping away mid-download can't show "Saved" over a different, unsaved photo. VoiceOver is
  // told via announceForAccessibility (accessibilityLiveRegion is Android-only — a no-op on this iOS app).
  const [savingId, setSavingId] = useState<string | null>(null);
  const [toast, setToast] = useState<{ id: string; kind: SaveToast } | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (toastTimer.current) clearTimeout(toastTimer.current); }, []);

  // Re-fetch a FRESH presigned download URL for one photo id, bypassing the (possibly-expired) snapshot the
  // viewer opened with. Scans a bounded number of pages of the viewed project's photo list. Returns null if
  // we can't resolve a fresh URL (no deal scope, photo not found, or the fetch fails).
  const fetchFreshUrl = useCallback(
    async (dealId: string, photoId: string): Promise<string | null> => {
      for (let page = 1; page <= REFRESH_MAX_PAGES; page += 1) {
        let res: Awaited<ReturnType<typeof getProjectPhotos>>;
        try {
          res = await getProjectPhotos(fetcher, dealId, { page, perPage: REFRESH_PER_PAGE });
        } catch {
          return null; // network/auth error — fall back to the generic failure toast
        }
        const found = res.photos.find((p) => p.id === photoId);
        if (found) return found.fullImageUrl ?? found.imageUrl ?? null;
        const totalPages = res.pagination?.totalPages ?? 1;
        if (page >= totalPages) break; // no more pages to scan
      }
      return null;
    },
    [fetcher],
  );

  /** The URL to display/save for a photo: a re-minted one if we've had to refresh, else the snapshot. */
  const uriFor = useCallback(
    (photo: FieldPhoto): string | null => freshUrls[photo.id] ?? photo.fullImageUrl ?? photo.imageUrl,
    [freshUrls],
  );

  // A failed full-res load is overwhelmingly an EXPIRED presigned URL — the viewer snapshots the photo list
  // at open time and those URLs are minted with a fixed TTL, so a gallery left open (or restored from the
  // query cache) hands the pager links that now 403. The server's own note on the list TTL says "the client
  // also refreshes on image error"; nothing actually did. This implements that contract: re-mint once per
  // photo, swap the URL in, and only show an error if the fresh URL fails too.
  const handleLoadError = useCallback(
    async (photo: FieldPhoto) => {
      const refreshDealId = projectDealId ?? photo.dealId ?? undefined;
      if (refreshAttempted.current.has(photo.id) || !refreshDealId) {
        setLoadState((prev) => ({ ...prev, [photo.id]: "error" }));
        return;
      }
      refreshAttempted.current.add(photo.id);
      const staleUrl = uriFor(photo);
      const fresh = await fetchFreshUrl(refreshDealId, photo.id);
      if (fresh && fresh !== staleUrl) {
        // Back to "loading": the swapped-in URL remounts the image and will report its own outcome.
        setLoadState((prev) => ({ ...prev, [photo.id]: "loading" }));
        setFreshUrls((prev) => ({ ...prev, [photo.id]: fresh }));
        return;
      }
      setLoadState((prev) => ({ ...prev, [photo.id]: "error" }));
    },
    [projectDealId, uriFor, fetchFreshUrl],
  );

  /**
   * Manual retry from the error state. Clearing the one-shot guard and setting "loading" is not enough on
   * its own: the uri is unchanged, and both the pager's key and expo-image's recyclingKey are derived from
   * it, so nothing would re-request the image and Retry would spin forever. The nonce changes the key, which
   * remounts the image and starts a genuinely new load.
   */
  const retryLoad = useCallback((photo: FieldPhoto) => {
    refreshAttempted.current.delete(photo.id);
    setLoadState((prev) => ({ ...prev, [photo.id]: "loading" }));
    setRetryNonce((prev) => ({ ...prev, [photo.id]: (prev[photo.id] ?? 0) + 1 }));
  }, []);

  const saveToDevice = useCallback(async () => {
    if (savingId != null || !current) return; // one save at a time
    const url = uriFor(current);
    if (!url) return; // no image to save (placeholder / unresolved URL) — the action is hidden, but guard anyway
    const targetId = current.id;
    setSavingId(targetId);
    let result = await savePhotoToDevice(url);
    // A "failed" result on a valid URL is most often an EXPIRED presigned link (the viewer snapshotted the
    // list at open time; R2 URLs live ~30 min). Re-fetch a fresh URL for this photo and retry ONCE before
    // surfacing the error — a permission denial or a genuinely broken photo won't be masked (we only retry on
    // "failed", and only when we resolve a DIFFERENT, fresh URL). Uses the VIEWED project's deal scope.
    const refreshDealId = projectDealId ?? current.dealId ?? undefined;
    if (result === "failed" && refreshDealId) {
      const freshUrl = await fetchFreshUrl(refreshDealId, targetId);
      if (freshUrl && freshUrl !== url) result = await savePhotoToDevice(freshUrl);
    }
    setSavingId(null);
    const kind: SaveToast = result === "saved" ? "saved" : result === "permission_denied" ? "permission" : "error";
    setToast({ id: targetId, kind });
    AccessibilityInfo.announceForAccessibility(SAVE_TOAST_TEXT[kind]);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 2600);
    // uriFor is a dependency, not an incidental call: it closes over freshUrls, so omitting it pins this
    // callback to the URL the viewer opened with. Save would then download the expired snapshot link, fail,
    // and re-run the page scan to re-mint a URL the screen is already displaying.
  }, [savingId, current, projectDealId, fetchFreshUrl, uriFor]);

  return (
    <Modal visible={visible} animationType="fade" onRequestClose={onClose} transparent={false}>
      {/* A fullScreen Modal renders in its own native window outside the app's SafeAreaProvider,
          so the viewer's SafeAreaView needs its own provider to resolve real insets — otherwise
          the Close button / counter land under the Dynamic Island and the detail panel runs under
          the home indicator. (Matches the CameraCapture / ReviewTray pattern.) */}
      <SafeAreaProvider>
      <GestureHandlerRootView style={styles.backdrop}>
      <View style={styles.backdrop}>
        <SafeAreaView style={styles.safe} edges={["top", "bottom"]}>
          <View style={styles.topBar}>
            <Text style={styles.counter}>
              {photos.length ? `${safeIndex + 1} / ${photos.length}` : ""}
            </Text>
            <View style={styles.topBarActions}>
              {/* Only advertise Save when there's actually a URL to download — a placeholder / unresolved
                  photo would let the download 403/fail with a generic error, so hide the action instead. */}
              {current && uriFor(current) ? (
                <Pressable
                  onPress={saveToDevice}
                  hitSlop={12}
                  disabled={savingId != null}
                  style={styles.saveButton}
                  accessibilityRole="button"
                  accessibilityLabel="Save photo to device"
                >
                  {savingId === current.id ? (
                    <ActivityIndicator size="small" color={theme.color.textInverse} />
                  ) : (
                    <Ionicons name="download-outline" size={22} color={theme.color.textInverse} />
                  )}
                </Pressable>
              ) : null}
              <Pressable onPress={onClose} hitSlop={12} accessibilityLabel="Close viewer">
                <Text style={styles.close}>Close</Text>
              </Pressable>
            </View>
          </View>

          <View style={[styles.pager, { height: height * 0.58 }]}>
            <FlatList
              ref={listRef}
              data={photos}
              keyExtractor={(p) => p.id}
              horizontal
              pagingEnabled
              extraData={safeIndex}
              scrollEnabled={!zoomed}
              showsHorizontalScrollIndicator={false}
              initialScrollIndex={initialIndex}
              getItemLayout={(_, i) => ({ length: width, offset: width * i, index: i })}
              // Make the initial jump actually LAND. VirtualizedList freezes its render window while
              // pendingScrollUpdateCount > 0 (set whenever initialScrollIndex > 0) and only clears it on a
              // real scroll event, while its one-shot programmatic scroll is fire-and-forget with no retry.
              // Natively that scroll is clamped against the content width MEASURED AT CALL TIME, so on a
              // 3533-photo pager (~1.39M px of content) an early call clamps to ~0 and the viewport parks on
              // the empty leading spacer — a black pane with a correct counter and correct metadata, and not
              // even the "Image unavailable" fallback, because the mounted cell is simply parked off-screen.
              // Re-issuing once the content is measured wide enough to hold the target offset defeats the
              // clamp, and the resulting scroll event thaws the window.
              onContentSizeChange={(contentWidth) => {
                if (initialScrollLanded.current) return;
                const target = initialIndex * width;
                if (!canLandInitialScroll(contentWidth, target, width)) return;
                initialScrollLanded.current = true;
                if (target > 0) listRef.current?.scrollToOffset({ offset: target, animated: false });
              }}
              // getItemLayout makes this near-impossible, but a failed jump must not leave a black pane.
              onScrollToIndexFailed={({ index: failedIndex }) => {
                listRef.current?.scrollToOffset({ offset: failedIndex * width, animated: false });
              }}
              // Keep the mount window small — RN's default (21) would mount ~20 decodes on a large gallery
              // and jetsam older field iPhones. Note windowSize={3} does NOT mean "current ± one neighbor" as
              // an earlier note here claimed: it is an overscan of (3-1) screen widths split around the
              // viewport, so the settled window is 4 cells, measured. That over-claim mattered when every
              // mounted page decoded the full-res original; pages now decode downscaled until zoomed
              // (see ZoomablePhoto), so 4 mounted cells is cheap and neighbors still preload for smooth swiping.
              windowSize={3}
              maxToRenderPerBatch={2}
              initialNumToRender={2}
              onMomentumScrollEnd={onScrollEnd}
              renderItem={({ item, index: itemIndex }) => {
                const uri = uriFor(item);
                const state = loadState[item.id];
                return (
                  <View style={{ width, height: height * 0.58, alignItems: "center", justifyContent: "center" }}>
                    {uri ? (
                      <>
                        <ZoomablePhoto
                          // Keyed by the URL so a re-minted link remounts the image and re-runs the load
                          // instead of expo-image holding on to the failed one; the retry nonce does the
                          // same when the user asks again for a URL that hasn't changed.
                          key={`${uri}#${retryNonce[item.id] ?? 0}`}
                          uri={uri}
                          thumbnailUri={item.imageUrl}
                          cacheKey={item.id}
                          width={width}
                          height={height * 0.58}
                          active={itemIndex === safeIndex}
                          onZoomChange={(z) => itemIndex === safeIndex && setZoomed(z)}
                          onLoadStart={() =>
                            setLoadState((prev) => (prev[item.id] ? prev : { ...prev, [item.id]: "loading" }))
                          }
                          onLoad={() => setLoadState((prev) => ({ ...prev, [item.id]: "loaded" }))}
                          onError={() => void handleLoadError(item)}
                        />
                        {state === "loading" ? (
                          <View style={styles.imageOverlay} pointerEvents="none">
                            <ActivityIndicator size="large" color={theme.color.textInverse} />
                          </View>
                        ) : null}
                        {state === "error" ? (
                          <View style={styles.imageOverlay}>
                            <Text style={styles.noImage}>Couldn't load this photo</Text>
                            <Pressable
                              onPress={() => retryLoad(item)}
                              hitSlop={10}
                              style={styles.retryButton}
                              accessibilityRole="button"
                              accessibilityLabel="Retry loading photo"
                            >
                              <Text style={styles.retryText}>Retry</Text>
                            </Pressable>
                          </View>
                        ) : null}
                      </>
                    ) : (
                      <Text style={styles.noImage}>Image unavailable</Text>
                    )}
                  </View>
                );
              }}
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
            {toast && current && toast.id === current.id ? (
              <View style={styles.toast} pointerEvents="none">
                <Ionicons
                  name={toast.kind === "saved" ? "checkmark-circle" : "alert-circle"}
                  size={16}
                  color={theme.color.textInverse}
                />
                <Text style={styles.toastText}>{SAVE_TOAST_TEXT[toast.kind]}</Text>
              </View>
            ) : null}
          </View>

          {current ? (
            <ScrollView style={styles.details} contentContainerStyle={{ padding: theme.space.lg, gap: 8 }}>
              <View style={styles.detailTitleRow}>
                <Text style={styles.detailTitle} numberOfLines={2}>
                  {current.displayName}
                </Text>
                <Pressable onPress={openEdit} hitSlop={10} accessibilityRole="button" accessibilityLabel="Edit photo details">
                  <Ionicons name="create-outline" size={22} color={theme.color.brandRed} />
                </Pressable>
              </View>
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
      </GestureHandlerRootView>
      </SafeAreaProvider>

      <Modal visible={editingOpen} animationType="slide" transparent onRequestClose={() => setEditingOpen(false)}>
        <SafeAreaProvider>
          <View style={styles.editBackdrop}>
            <SafeAreaView style={styles.editSheet} edges={["bottom"]}>
              <Text style={styles.editHeading}>Edit photo details</Text>
              <Text style={styles.editLabel}>Name</Text>
              <TextInput value={editName} onChangeText={setEditName} placeholder="Photo name" autoFocus />
              <Text style={styles.editLabel}>Description</Text>
              <TextInput
                value={editDesc}
                onChangeText={setEditDesc}
                placeholder="Describe this photo"
                multiline
                style={styles.editDescInput}
              />
              {updateMeta.isError ? (
                <Text style={{ color: "#dc2626", fontSize: 13, marginTop: 8 }}>
                  Couldn't save. Check your connection and try again.
                </Text>
              ) : null}
              <View style={styles.editActions}>
                <Button title="Cancel" variant="ghost" onPress={() => setEditingOpen(false)} disabled={updateMeta.isPending} />
                <Button title="Save" onPress={saveEdit} loading={updateMeta.isPending} disabled={!editName.trim()} />
              </View>
            </SafeAreaView>
          </View>
        </SafeAreaProvider>
      </Modal>
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
  topBarActions: { flexDirection: "row", alignItems: "center", gap: theme.space.lg },
  saveButton: { width: 28, alignItems: "center", justifyContent: "center" },
  close: { color: theme.color.textInverse, fontFamily: theme.font.semibold, fontSize: 16 },
  toast: {
    position: "absolute",
    bottom: theme.space.lg,
    alignSelf: "center",
    flexDirection: "row",
    alignItems: "center",
    gap: theme.space.xs,
    backgroundColor: "rgba(0,0,0,0.8)",
    paddingHorizontal: theme.space.md,
    paddingVertical: theme.space.sm,
    borderRadius: theme.radius.md,
  },
  toastText: { color: theme.color.textInverse, fontFamily: theme.font.semibold, fontSize: 13 },
  noImage: { color: theme.color.textInverse, fontFamily: theme.font.body },
  // Sits over the photo rather than replacing it, so the thumbnail placeholder underneath stays visible
  // while the full-res original loads (or after it fails).
  imageOverlay: { ...StyleSheet.absoluteFillObject, alignItems: "center", justifyContent: "center", gap: theme.space.md },
  retryButton: {
    paddingHorizontal: theme.space.lg,
    paddingVertical: theme.space.sm,
    borderRadius: theme.radius.pill,
    backgroundColor: theme.color.brandRed,
  },
  retryText: { color: theme.color.textInverse, fontFamily: theme.font.semibold, fontSize: 14 },
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
  detailTitleRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: theme.space.md },
  detailTitle: { flex: 1, fontFamily: theme.font.bold, fontSize: 18, color: theme.color.textPrimary },
  editBackdrop: { flex: 1, justifyContent: "flex-end", backgroundColor: "rgba(0,0,0,0.5)" },
  editSheet: {
    backgroundColor: theme.color.surfaceCard,
    borderTopLeftRadius: theme.radius.lg,
    borderTopRightRadius: theme.radius.lg,
    padding: theme.space.lg,
    gap: theme.space.sm,
  },
  editHeading: { fontFamily: theme.font.bold, fontSize: 18, color: theme.color.textPrimary, marginBottom: theme.space.sm },
  editLabel: { fontFamily: theme.font.semibold, fontSize: 13, color: theme.color.textMuted },
  editDescInput: { minHeight: 88, textAlignVertical: "top" },
  editActions: { flexDirection: "row", justifyContent: "flex-end", gap: theme.space.md, marginTop: theme.space.md },
  detailRow: { flexDirection: "row", gap: theme.space.md },
  detailLabel: { fontFamily: theme.font.semibold, fontSize: 13, color: theme.color.textMuted, width: 96 },
  detailValue: { fontFamily: theme.font.body, fontSize: 14, color: theme.color.textPrimary, flex: 1 },
});
