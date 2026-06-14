import React, { useMemo, useState } from "react";
import { Linking, Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useLocalSearchParams, useRouter } from "expo-router";
import { theme } from "../../../src/theme/theme";
import { useProjectPhotos, useProjectReports } from "../../../src/query/hooks";
import { useAuth } from "../../../src/auth/AuthContext";
import { getReportDownload } from "../../../src/api/endpoints";
import {
  categoryLabel,
  filterPhotos,
  groupPhotos,
  isProjectOffOffice,
  tagsOf,
  uploadersOf,
  type FieldPhoto,
  type PhotoGrouping,
} from "../../../src/projects/field-projects";
import { Badge, Button, Chip, EmptyState, LoadingState, SectionLabel } from "../../../src/components/ui";
import { Banner } from "../../../src/components/Banner";
import { ScreenHeader } from "../../../src/components/ScreenHeader";
import { PhotoGrid } from "../../../src/components/PhotoGrid";
import { PhotoViewerModal } from "../../../src/components/PhotoViewerModal";
import { ReportBuilder } from "../../../src/components/ReportBuilder";
import { PhotoShareModal } from "../../../src/components/PhotoShareModal";
import { Ionicons } from "@expo/vector-icons";

const GROUPINGS: { value: PhotoGrouping; label: string }[] = [
  { value: "date", label: "Date" },
  { value: "category", label: "Category" },
  { value: "uploader", label: "Uploader" },
  { value: "none", label: "None" },
];

function toStr(v: string | string[] | undefined): string {
  return Array.isArray(v) ? v[0] ?? "" : v ?? "";
}

export default function ProjectDetailScreen() {
  const params = useLocalSearchParams<{
    id: string;
    name?: string;
    dealNumber?: string;
    propertyAddress?: string;
    stage?: string;
    officeId?: string;
    officeSlug?: string;
  }>();
  const dealId = toStr(params.id);
  const router = useRouter();
  const { fetcher, user, activeOfficeId } = useAuth();
  // Off-office projects are view-only until cross-office writes ship: the single-office report/capture
  // writes would 404 against the active office's schema. The owning office arrives via nav params; if it
  // wasn't passed (e.g. a direct deep link), default to writable and let the server stay the authority.
  const writableOfficeId = activeOfficeId ?? user?.tenantId;
  const projectOfficeId = toStr(params.officeId);
  const officeSlug = toStr(params.officeSlug);
  const offOffice = projectOfficeId ? isProjectOffOffice({ officeId: projectOfficeId }, writableOfficeId) : false;

  const photosQuery = useProjectPhotos(dealId);
  const reportsQuery = useProjectReports(dealId);
  const allPhotos = useMemo(() => photosQuery.data?.photos ?? [], [photosQuery.data]);

  const [grouping, setGrouping] = useState<PhotoGrouping>("date");
  const [categories, setCategories] = useState<string[]>([]);
  const [tags, setTags] = useState<string[]>([]);
  const [uploaderIds, setUploaderIds] = useState<string[]>([]);
  const [showFilters, setShowFilters] = useState(false);
  // Snapshot the photo list + index at open time so a background refetch or a
  // filter change can never desync the viewer onto a different photo.
  const [viewer, setViewer] = useState<{ photos: FieldPhoto[]; index: number } | null>(null);
  const [reportOpen, setReportOpen] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);
  const [notice, setNotice] = useState<{ message: string; tone: "success" | "error" } | null>(null);

  const availableTags = useMemo(() => tagsOf(allPhotos), [allPhotos]);
  const availableUploaders = useMemo(() => uploadersOf(allPhotos), [allPhotos]);
  const availableCategories = useMemo(() => {
    const set = new Set<string>();
    for (const p of allPhotos) set.add(p.photoCategory ?? p.subcategory ?? "uncategorized");
    return Array.from(set);
  }, [allPhotos]);

  const filtered = useMemo(
    () => filterPhotos(allPhotos, { categories, tags, uploaderIds, from: "", to: "" }),
    [allPhotos, categories, tags, uploaderIds],
  );
  const groups = useMemo(() => groupPhotos(filtered, grouping), [filtered, grouping]);
  const flattened = useMemo(() => groups.flatMap((g) => g.photos), [groups]);

  function toggle(list: string[], value: string, set: (next: string[]) => void) {
    set(list.includes(value) ? list.filter((v) => v !== value) : [...list, value]);
  }

  function openPhoto(photo: FieldPhoto) {
    const idx = flattened.findIndex((p) => p.id === photo.id);
    setViewer({ photos: flattened, index: idx < 0 ? 0 : idx });
  }

  async function openReport(reportId: string) {
    try {
      const { url } = await getReportDownload(fetcher, reportId);
      await Linking.openURL(url);
    } catch {
      setNotice({ message: "Couldn't open that report.", tone: "error" });
    }
  }

  const refreshing = photosQuery.isRefetching || reportsQuery.isRefetching;

  return (
    <SafeAreaView style={styles.safe} edges={["top"]}>
      <ScreenHeader onBack={() => router.back()} title={toStr(params.name) || "Project"} />

      <ScrollView
        contentContainerStyle={styles.body}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => {
              void photosQuery.refetch();
              void reportsQuery.refetch();
            }}
            tintColor={theme.color.brandRed}
          />
        }
      >
        {/* Name lives in the persistent header band now; the body leads with stage + address + meta. */}
        <View style={{ gap: theme.space.xs }}>
          {params.stage ? <Badge label={toStr(params.stage)} /> : null}
          {params.propertyAddress ? <Text style={styles.address}>{toStr(params.propertyAddress)}</Text> : null}
          <Text style={styles.meta}>
            #{toStr(params.dealNumber)} · {allPhotos.length} photo{allPhotos.length === 1 ? "" : "s"}
          </Text>
        </View>

        {offOffice ? (
          <Banner
            message={`Managed by the ${officeSlug} office — view only. Photos and reports are visible here; starring, report generation, and photo capture are available from that office.`}
          />
        ) : (
          <View style={styles.actions}>
            <Button
              title="Add photos"
              onPress={() =>
                router.push({
                  pathname: "/(app)/capture",
                  params: {
                    dealId,
                    targetName: toStr(params.name),
                    dealNumber: toStr(params.dealNumber),
                    stage: toStr(params.stage),
                    propertyAddress: toStr(params.propertyAddress),
                  },
                })
              }
              style={{ flex: 1 }}
            />
            <Button
              title="Build report"
              variant="ghost"
              // Gate on the FILTERED set the builder actually receives — otherwise
              // active filters that exclude every photo still enable Build and open
              // an empty builder (#15).
              onPress={() => setReportOpen(true)}
              disabled={filtered.length === 0}
              style={{ flex: 1 }}
            />
          </View>
        )}

        {/* Share works cross-office: the endpoint resolves the deal's owning office and mints only a
            public photo token (no deal mutation), so — unlike capture/report generation — it stays
            available even on view-only off-office projects. */}
        {filtered.length > 0 ? (
          <Button
            title="Share photos"
            variant="ghost"
            icon={<Ionicons name="share-outline" size={18} color={theme.color.brandRed} />}
            onPress={() => setShareOpen(true)}
          />
        ) : null}

        {notice ? <Banner message={notice.message} tone={notice.tone} /> : null}

        {/* Grouping + filters — only meaningful once there are photos to group/filter (#13). */}
        {allPhotos.length > 0 ? (
          <View style={{ gap: theme.space.sm }}>
            <View style={styles.rowBetween}>
              <SectionLabel>Group by</SectionLabel>
              <Pressable onPress={() => setShowFilters((s) => !s)} hitSlop={10}>
                <Text style={styles.linkMuted}>{showFilters ? "Hide filters" : "Filters"}</Text>
              </Pressable>
            </View>
          <View style={styles.chipRow}>
            {GROUPINGS.map((g) => (
              <Chip key={g.value} label={g.label} selected={grouping === g.value} onPress={() => setGrouping(g.value)} />
            ))}
          </View>

          {showFilters ? (
            <View style={{ gap: theme.space.md, marginTop: theme.space.sm }}>
              {availableCategories.length > 0 ? (
                <View style={{ gap: theme.space.xs }}>
                  <SectionLabel>Category</SectionLabel>
                  <View style={styles.chipRow}>
                    {availableCategories.map((c) => (
                      <Chip
                        key={c}
                        label={categoryLabel(c === "uncategorized" ? null : c)}
                        selected={categories.includes(c)}
                        onPress={() => toggle(categories, c, setCategories)}
                      />
                    ))}
                  </View>
                </View>
              ) : null}
              {availableTags.length > 0 ? (
                <View style={{ gap: theme.space.xs }}>
                  <SectionLabel>Tags</SectionLabel>
                  <View style={styles.chipRow}>
                    {availableTags.map((t) => (
                      <Chip key={t} label={t} selected={tags.includes(t)} onPress={() => toggle(tags, t, setTags)} />
                    ))}
                  </View>
                </View>
              ) : null}
              {availableUploaders.length > 1 ? (
                <View style={{ gap: theme.space.xs }}>
                  <SectionLabel>Uploader</SectionLabel>
                  <View style={styles.chipRow}>
                    {availableUploaders.map((u) => (
                      <Chip
                        key={u.id}
                        label={u.name}
                        selected={uploaderIds.includes(u.id)}
                        onPress={() => toggle(uploaderIds, u.id, setUploaderIds)}
                      />
                    ))}
                  </View>
                </View>
              ) : null}
            </View>
            ) : null}
          </View>
        ) : null}

        {/* Gallery */}
        {photosQuery.isLoading ? (
          <LoadingState label="Loading photos…" />
        ) : flattened.length === 0 ? (
          <EmptyState
            title="No photos"
            subtitle={allPhotos.length === 0 ? "Capture photos to see them here." : "No photos match these filters."}
          />
        ) : (
          <View style={{ gap: theme.space.lg }}>
            {groups.map((group) => (
              <View key={group.label} style={{ gap: theme.space.sm }}>
                <Text style={styles.groupLabel}>{group.label}</Text>
                <PhotoGrid photos={group.photos} onPress={openPhoto} />
              </View>
            ))}
          </View>
        )}

        {/* Reports */}
        <View style={{ gap: theme.space.sm }}>
          <SectionLabel>Reports</SectionLabel>
          {reportsQuery.isLoading ? (
            <LoadingState label="Loading reports…" />
          ) : (reportsQuery.data?.reports ?? []).length === 0 ? (
            <Text style={styles.meta}>
              {offOffice
                ? "No reports yet."
                : allPhotos.length === 0
                  ? "No reports yet. Build one once you've added photos."
                  : "No reports yet. Build one from the photos above."}
            </Text>
          ) : (
            (reportsQuery.data?.reports ?? []).map((report) => (
              <Pressable
                key={report.id}
                onPress={() => openReport(report.id)}
                style={({ pressed }) => [styles.reportRow, pressed && { opacity: 0.7 }]}
              >
                <Text style={styles.reportTitle} numberOfLines={1}>
                  {report.title}
                </Text>
                <Text style={styles.link}>Open PDF</Text>
              </Pressable>
            ))
          )}
        </View>
      </ScrollView>

      {viewer !== null ? (
        <PhotoViewerModal photos={viewer.photos} initialIndex={viewer.index} visible onClose={() => setViewer(null)} />
      ) : null}

      <ReportBuilder
        visible={reportOpen}
        onClose={() => setReportOpen(false)}
        projectId={dealId}
        photos={filtered}
        onGenerated={(report) => {
          setNotice({ message: `Report "${report.title}" generated.`, tone: "success" });
          void reportsQuery.refetch();
          if (report.pdfUrl) void Linking.openURL(report.pdfUrl);
        }}
      />

      <PhotoShareModal
        visible={shareOpen}
        onClose={() => setShareOpen(false)}
        projectId={dealId}
        photos={filtered}
        onShared={(n) => setNotice({ message: `Share link created for ${n} photo${n === 1 ? "" : "s"} — expires in 7 days.`, tone: "success" })}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: theme.color.surfaceApp },
  body: { padding: theme.space.lg, gap: theme.space.lg, paddingBottom: theme.space.xxl },
  address: { fontFamily: theme.font.body, fontSize: 14, color: theme.color.textMuted },
  meta: { fontFamily: theme.font.body, fontSize: 13, color: theme.color.textMuted },
  actions: { flexDirection: "row", gap: theme.space.md },
  rowBetween: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  link: { fontFamily: theme.font.semibold, fontSize: 14, color: theme.color.brandRed },
  // Muted so the "Filters" toggle doesn't compete with the red primary "Add photos".
  linkMuted: { fontFamily: theme.font.semibold, fontSize: 14, color: theme.color.textMuted },
  chipRow: { flexDirection: "row", flexWrap: "wrap", gap: theme.space.sm },
  groupLabel: { fontFamily: theme.font.semibold, fontSize: 15, color: theme.color.textPrimary },
  reportRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.space.md,
    backgroundColor: theme.color.surfaceCard,
    borderWidth: 1,
    borderColor: theme.color.border,
    borderRadius: theme.radius.md,
    padding: theme.space.md,
  },
  reportTitle: { flex: 1, fontFamily: theme.font.medium, fontSize: 14, color: theme.color.textPrimary },
});
