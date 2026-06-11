import React, { useEffect, useRef, useState } from "react";
import { Image, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import * as ImagePicker from "expo-image-picker";
import { theme } from "../../src/theme/theme";
import { useAuth } from "../../src/auth/AuthContext";
import { usePendingPhotos } from "../../src/query/hooks";
import { qk } from "../../src/query/keys";
import { assignPhotoTarget, getTranscriptionConfig } from "../../src/api/endpoints";
import type { FieldCaptureTarget } from "../../src/api/types";
import { extractExifMetadata, getLiveGps, type PhotoMetadata } from "../../src/capture/metadata";
import { runConcurrentUploads, uploadCapture, type CaptureTargetRef } from "../../src/capture/upload";
import { Badge, Button, EmptyState, TextInput } from "../../src/components/ui";
import { Banner } from "../../src/components/Banner";
import { CategoryPicker } from "../../src/components/CategoryPicker";
import { PhotoTagInput } from "../../src/components/PhotoTagInput";
import { VoiceRecorder } from "../../src/components/VoiceRecorder";
import { TargetPicker } from "../../src/components/TargetPicker";

type SelectedTarget = { id: string; type: "deal" | "lead" | "opportunity"; name: string };
type SessionPhoto = { key: string; uri: string; width?: number; height?: number; metadata: PhotoMetadata };
type UploadStatus = "idle" | "uploading" | "failed";

function targetRef(t: SelectedTarget | null): CaptureTargetRef {
  if (!t) return {};
  if (t.type === "deal") return { dealId: t.id };
  if (t.type === "lead") return { leadId: t.id };
  return { opportunityId: t.id };
}

function hasCoords(m: PhotoMetadata): boolean {
  return m.latitude !== undefined && m.longitude !== undefined;
}

export default function CaptureScreen() {
  const params = useLocalSearchParams<{
    dealId?: string;
    targetName?: string;
    dealNumber?: string;
    stage?: string;
    propertyAddress?: string;
  }>();
  const router = useRouter();
  const { fetcher, user } = useAuth();
  const qc = useQueryClient();

  const initialTarget: SelectedTarget | null =
    typeof params.dealId === "string" && params.dealId
      ? { id: params.dealId, type: "deal", name: typeof params.targetName === "string" ? params.targetName : "Project" }
      : null;

  const [target, setTarget] = useState<SelectedTarget | null>(initialTarget);

  // Capture is a tab and stays mounted; when the user taps "Add photos" from a
  // (different) project the route params change but useState(initialTarget) only
  // applied on first mount — re-sync so the upload attaches to the chosen project.
  useEffect(() => {
    if (typeof params.dealId === "string" && params.dealId) {
      setTarget({
        id: params.dealId,
        type: "deal",
        name: typeof params.targetName === "string" ? params.targetName : "Project",
      });
    }
  }, [params.dealId, params.targetName]);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [assigningPhotoId, setAssigningPhotoId] = useState<string | null>(null);
  const [photos, setPhotos] = useState<SessionPhoto[]>([]);
  const [category, setCategory] = useState<string | null>(null);
  const [caption, setCaption] = useState("");
  const [tags, setTags] = useState<string[]>([]);
  const [status, setStatus] = useState<UploadStatus>("idle");
  const [notice, setNotice] = useState<{ tone: "error" | "success"; text: string } | null>(null);
  const keyCounter = useRef(0);

  const pendingQuery = usePendingPhotos();
  const transcribeConfig = useQuery({
    queryKey: ["transcribe-config"],
    queryFn: () => getTranscriptionConfig(fetcher),
    staleTime: 5 * 60_000,
  });

  function nextKey() {
    keyCounter.current += 1;
    return `sp-${keyCounter.current}`;
  }

  // Bust a deal's cached gallery (staleTime is 30s) so newly confirmed photos
  // appear immediately on the detail screen instead of after a manual refresh.
  function invalidateDealPhotos(dealId: string) {
    if (user) void qc.invalidateQueries({ queryKey: qk.projectPhotos(user.id, dealId) });
  }

  // We only have the deal's number/stage/address when we arrived from that deal's
  // "Add photos" (passed as params) — pass them through on the return navigation
  // so the detail screen renders full metadata instead of just name + photo count.
  function detailParamsFor(t: SelectedTarget): Record<string, string> {
    const out: Record<string, string> = { id: t.id, name: t.name };
    if (typeof params.dealId === "string" && params.dealId === t.id) {
      if (typeof params.dealNumber === "string") out.dealNumber = params.dealNumber;
      if (typeof params.stage === "string") out.stage = params.stage;
      if (typeof params.propertyAddress === "string") out.propertyAddress = params.propertyAddress;
    }
    return out;
  }

  async function addAssets(assets: ImagePicker.ImagePickerAsset[], source: "camera" | "library") {
    let live: PhotoMetadata | null = null;
    const needsLive = source === "camera" || assets.some((a) => !hasCoords(extractExifMetadata(a.exif as Record<string, unknown>)));
    if (needsLive) live = await getLiveGps();

    const next: SessionPhoto[] = assets.map((asset) => {
      const exifMeta = source === "library" ? extractExifMetadata(asset.exif as Record<string, unknown>) : {};
      const metadata: PhotoMetadata = hasCoords(exifMeta)
        ? exifMeta
        : { ...(live ?? {}), takenAt: exifMeta.takenAt ?? live?.takenAt ?? new Date().toISOString() };
      return { key: nextKey(), uri: asset.uri, width: asset.width, height: asset.height, metadata };
    });
    setPhotos((prev) => [...prev, ...next]);
  }

  async function takePhoto() {
    if (status === "uploading") return;
    setNotice(null);
    const perm = await ImagePicker.requestCameraPermissionsAsync();
    if (!perm.granted) {
      setNotice({ tone: "error", text: "Camera permission is required. You can import from your library instead." });
      return;
    }
    const result = await ImagePicker.launchCameraAsync({
      mediaTypes: ["images"],
      quality: 1,
      exif: true,
      cameraType: ImagePicker.CameraType.back,
    });
    if (!result.canceled) await addAssets(result.assets, "camera");
  }

  async function importPhotos() {
    if (status === "uploading") return;
    setNotice(null);
    const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!perm.granted) {
      setNotice({ tone: "error", text: "Photo library permission is required to import photos." });
      return;
    }
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ["images"],
      allowsMultipleSelection: true,
      quality: 1,
      exif: true,
    });
    if (!result.canceled) await addAssets(result.assets, "library");
  }

  function removePhoto(key: string) {
    if (status === "uploading") return;
    setPhotos((prev) => prev.filter((p) => p.key !== key));
  }

  async function upload() {
    if (photos.length === 0 || status === "uploading") return;
    setStatus("uploading");
    setNotice(null);
    const ref = targetRef(target);
    const results = await runConcurrentUploads(photos, 3, (sp) =>
      uploadCapture(fetcher, {
        uri: sp.uri,
        width: sp.width,
        height: sp.height,
        target: ref,
        category,
        caption: caption.trim() || null,
        tags,
        metadata: sp.metadata,
      }),
    );

    const failedKeys = photos.filter((_, i) => results[i]?.status === "rejected").map((p) => p.key);
    const succeeded = results.filter((r) => r.status === "fulfilled").length;

    if (failedKeys.length === 0) {
      setPhotos([]);
      setCaption("");
      setTags([]);
      setCategory(null);
      setStatus("idle");
      setNotice({ tone: "success", text: `${succeeded} photo${succeeded === 1 ? "" : "s"} uploaded.` });
      void pendingQuery.refetch();
      if (target?.type === "deal") {
        invalidateDealPhotos(target.id);
        router.replace({ pathname: "/(app)/projects/[id]", params: detailParamsFor(target) });
      }
    } else {
      setPhotos((prev) => prev.filter((p) => failedKeys.includes(p.key)));
      setStatus("failed");
      setNotice({
        tone: "error",
        text: `${succeeded} uploaded, ${failedKeys.length} failed. Tap upload to retry the rest.`,
      });
      void pendingQuery.refetch();
      // The fulfilled uploads are already confirmed server-side — refresh the
      // gallery cache here too, not only on the all-success path.
      if (target?.type === "deal" && succeeded > 0) invalidateDealPhotos(target.id);
    }
  }

  async function assignPending(t: FieldCaptureTarget) {
    if (!assigningPhotoId) return;
    const photoId = assigningPhotoId;
    setAssigningPhotoId(null);
    try {
      await assignPhotoTarget(
        fetcher,
        photoId,
        t.type === "deal" ? { dealId: t.id } : t.type === "lead" ? { leadId: t.id } : { opportunityId: t.id },
      );
      void pendingQuery.refetch();
      if (t.type === "deal") invalidateDealPhotos(t.id);
      setNotice({ tone: "success", text: `Photo assigned to ${t.name}.` });
    } catch {
      setNotice({ tone: "error", text: "Couldn't assign that photo." });
    }
  }

  const pending = pendingQuery.data?.photos ?? [];
  const uploading = status === "uploading";

  return (
    <SafeAreaView style={styles.safe} edges={["top"]}>
      <ScrollView contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled">
        <Text style={styles.title}>Capture</Text>

        {/* Target */}
        <View style={styles.targetCard}>
          <View style={{ flex: 1 }}>
            <Text style={styles.targetLabel}>Project</Text>
            <Text style={styles.targetName} numberOfLines={1}>
              {target ? target.name : "No project — uploads to Pending"}
            </Text>
          </View>
          <View style={styles.targetActions}>
            {target ? (
              <Pressable onPress={() => setTarget(null)} disabled={uploading} hitSlop={8} accessibilityLabel="Clear project">
                <Text style={[styles.link, uploading && styles.linkDisabled]}>Clear</Text>
              </Pressable>
            ) : null}
            <Pressable onPress={() => setPickerOpen(true)} disabled={uploading} hitSlop={8}>
              <Text style={[styles.link, uploading && styles.linkDisabled]}>{target ? "Change" : "Choose"}</Text>
            </Pressable>
          </View>
        </View>

        {notice ? <Banner message={notice.text} tone={notice.tone} /> : null}

        {/* Capture buttons */}
        <View style={styles.actions}>
          <Button title="📷 Take photo" onPress={takePhoto} disabled={uploading} style={{ flex: 1 }} />
          <Button title="🖼 Import" variant="ghost" onPress={importPhotos} disabled={uploading} style={{ flex: 1 }} />
        </View>

        {/* Session thumbnails */}
        {photos.length > 0 ? (
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: theme.space.sm }}>
            {photos.map((p) => (
              <View key={p.key} style={styles.thumbWrap}>
                <Image source={{ uri: p.uri }} style={styles.thumb} />
                <Pressable
                  onPress={() => removePhoto(p.key)}
                  disabled={uploading}
                  style={[styles.remove, uploading && { opacity: 0.4 }]}
                  hitSlop={8}
                  accessibilityLabel="Remove photo"
                >
                  <Text style={styles.removeText}>✕</Text>
                </Pressable>
              </View>
            ))}
          </ScrollView>
        ) : null}

        {/* Metadata for the session */}
        {photos.length > 0 ? (
          <View style={{ gap: theme.space.md }}>
            <View style={{ gap: theme.space.xs }}>
              <Text style={styles.fieldLabel}>Category</Text>
              <CategoryPicker value={category} onChange={setCategory} />
            </View>

            <View style={{ gap: theme.space.xs }}>
              <Text style={styles.fieldLabel}>Description</Text>
              <TextInput
                value={caption}
                onChangeText={setCaption}
                placeholder="Describe these photos"
                multiline
                style={{ minHeight: 72, textAlignVertical: "top", paddingTop: 10 }}
              />
              {transcribeConfig.data?.configured ? (
                <VoiceRecorder onTranscript={(text) => setCaption((prev) => (prev ? `${prev} ${text}` : text))} />
              ) : null}
            </View>

            <View style={{ gap: theme.space.xs }}>
              <Text style={styles.fieldLabel}>Tags</Text>
              <PhotoTagInput tags={tags} onChange={setTags} dealId={target?.type === "deal" ? target.id : undefined} />
            </View>

            <Button
              title={`Upload ${photos.length} photo${photos.length === 1 ? "" : "s"}`}
              onPress={upload}
              loading={uploading}
            />
          </View>
        ) : (
          <EmptyState title="No photos yet" subtitle="Take a photo or import from your library to begin." />
        )}

        {/* Pending captures */}
        {pending.length > 0 ? (
          <View style={{ gap: theme.space.sm, marginTop: theme.space.md }}>
            <Text style={styles.fieldLabel}>Pending captures ({pending.length})</Text>
            <Text style={styles.hint}>Photos uploaded without a project. Assign each to a project.</Text>
            {pending.map((photo) => (
              <View key={photo.id} style={styles.pendingRow}>
                {photo.imageUrl ? <Image source={{ uri: photo.imageUrl }} style={styles.pendingThumb} /> : <View style={[styles.pendingThumb, styles.placeholder]} />}
                <View style={{ flex: 1 }}>
                  <Text style={styles.pendingName} numberOfLines={1}>
                    {photo.displayName}
                  </Text>
                  <Badge label={photo.photoCategory ?? "Uncategorized"} />
                </View>
                <Pressable onPress={() => setAssigningPhotoId(photo.id)} hitSlop={8}>
                  <Text style={styles.link}>Assign</Text>
                </Pressable>
              </View>
            ))}
          </View>
        ) : null}
      </ScrollView>

      {/* Target picker for the session */}
      <TargetPicker
        visible={pickerOpen}
        onClose={() => setPickerOpen(false)}
        onSelect={(t) => {
          setTarget({ id: t.id, type: t.type, name: t.name });
          setPickerOpen(false);
        }}
      />
      {/* Target picker for assigning a pending photo */}
      <TargetPicker
        visible={assigningPhotoId !== null}
        onClose={() => setAssigningPhotoId(null)}
        onSelect={assignPending}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: theme.color.surfaceApp },
  body: { padding: theme.space.lg, gap: theme.space.md, paddingBottom: theme.space.xxl },
  title: { fontFamily: theme.font.bold, fontSize: 22, color: theme.color.textPrimary },
  targetCard: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.space.md,
    backgroundColor: theme.color.surfaceCard,
    borderWidth: 1,
    borderColor: theme.color.border,
    borderRadius: theme.radius.md,
    padding: theme.space.md,
  },
  targetLabel: { fontFamily: theme.font.medium, fontSize: 12, color: theme.color.textMuted },
  targetName: { fontFamily: theme.font.semibold, fontSize: 16, color: theme.color.textPrimary },
  link: { fontFamily: theme.font.semibold, fontSize: 14, color: theme.color.brandRed },
  linkDisabled: { opacity: 0.4 },
  targetActions: { flexDirection: "row", alignItems: "center", gap: theme.space.md },
  actions: { flexDirection: "row", gap: theme.space.md },
  thumbWrap: { position: "relative" },
  thumb: { width: 84, height: 84, borderRadius: theme.radius.sm, backgroundColor: theme.color.surfaceMuted },
  remove: {
    position: "absolute",
    top: -6,
    right: -6,
    width: 22,
    height: 22,
    borderRadius: 11,
    backgroundColor: theme.color.brandBlack,
    alignItems: "center",
    justifyContent: "center",
  },
  removeText: { color: theme.color.textInverse, fontSize: 12, fontFamily: theme.font.bold },
  fieldLabel: { fontFamily: theme.font.semibold, fontSize: 14, color: theme.color.textPrimary },
  hint: { fontFamily: theme.font.body, fontSize: 13, color: theme.color.textMuted },
  pendingRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.space.md,
    backgroundColor: theme.color.surfaceCard,
    borderWidth: 1,
    borderColor: theme.color.border,
    borderRadius: theme.radius.md,
    padding: theme.space.sm,
  },
  pendingThumb: { width: 48, height: 48, borderRadius: theme.radius.sm, backgroundColor: theme.color.surfaceMuted },
  placeholder: { borderWidth: 1, borderColor: theme.color.border },
  pendingName: { fontFamily: theme.font.medium, fontSize: 14, color: theme.color.textPrimary },
});
