import React, { useMemo, useState } from "react";
import { Linking, Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useLocalSearchParams, useRouter } from "expo-router";
import { theme } from "../../../src/theme/theme";
import { useQuery } from "@tanstack/react-query";
import { useProjectPhotos, useProjectReports, useProjectScorecards } from "../../../src/query/hooks";
import { useAuth } from "../../../src/auth/AuthContext";
import { getReportDownload, getTranscriptionConfig } from "../../../src/api/endpoints";
import {
  categoryLabel,
  correctiveAffordance,
  filterPhotos,
  groupPhotos,
  isProjectOffOffice,
  projectNumberLabel,
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
import { RatingBadge } from "../../../src/components/RatingBadge";
import { formatShortDate } from "../../../src/scorecards/detail-view";

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
    projectNumber?: string;
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
  const scorecardsQuery = useProjectScorecards(dealId);
  // Only offer voice dictation when transcription is actually configured (OPENAI_API_KEY present);
  // otherwise the mic button would record and 503 every time. Shared key/staleTime with the capture +
  // scorecard surfaces so react-query dedupes the probe.
  const transcribeConfig = useQuery({
    queryKey: ["transcribe-config"],
    queryFn: () => getTranscriptionConfig(fetcher),
    staleTime: 5 * 60_000,
  });
  const voiceEnabled = transcribeConfig.data?.configured ?? false;
  const scorecards = scorecardsQuery.data?.scorecards ?? [];
  const allPhotos = useMemo(() => photosQuery.data?.photos ?? [], [photosQuery.data]);
  // Some photo pages failed to load — the gallery still shows what loaded, but report/share are blocked so
  // we never generate from an incomplete set.
  const photosPartial = photosQuery.data?.partial ?? false;

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

  const refreshing = photosQuery.isRefetching || reportsQuery.isRefetching || scorecardsQuery.isRefetching;

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
              void scorecardsQuery.refetch();
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
            {projectNumberLabel(toStr(params.projectNumber) || null)} · {allPhotos.length} photo{allPhotos.length === 1 ? "" : "s"}
          </Text>
        </View>

        {offOffice ? (
          <Banner
            message={`Managed by the ${officeSlug} office — view only. Photos, reports, and scorecards are visible here; starring, report generation, and photo capture are available from that office.`}
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
                    projectNumber: toStr(params.projectNumber),
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
              disabled={filtered.length === 0 || photosPartial}
              style={{ flex: 1 }}
            />
          </View>
        )}

        {/* Share works cross-office: the endpoint resolves the deal's owning office and mints only a
            public photo token (no deal mutation), so — unlike capture/report generation — it stays
            available even on view-only off-office projects. */}
        {filtered.length > 0 && !photosPartial ? (
          <Button
            title="Share photos"
            variant="ghost"
            icon={<Ionicons name="share-outline" size={18} color={theme.color.brandRed} />}
            onPress={() => setShareOpen(true)}
          />
        ) : null}

        {photosPartial ? (
          <Banner
            message="Some photos couldn’t be loaded, so report and share are paused to avoid omitting any. Pull to refresh to try again."
            tone="error"
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

        {/* Scorecards — count on detail is the sole discoverability surface (no list badge, per non-goals). */}
        <View style={{ gap: theme.space.sm }}>
          <SectionLabel>Scorecards ({scorecards.length})</SectionLabel>
          {scorecardsQuery.isLoading ? (
            <LoadingState label="Loading scorecards…" />
          ) : scorecardsQuery.isError ? (
            // Don't let a load failure read as a genuinely-empty project — pull-to-refresh re-runs the query.
            <Text style={styles.meta}>Couldn't load scorecards. Pull to refresh.</Text>
          ) : scorecards.length === 0 ? (
            <Text style={styles.meta}>No scorecards yet.</Text>
          ) : (
            scorecards.map((s) => {
              // Kind-aware, exactly like the Scorecards submitted list: a leadership card's totalScore is
              // averageScore*10, so it must render as `X.X/10` (never `90/100`) and be labeled leadership.
              // The summary DTO carries kind + averageScore; fall back to totalScore/10 defensively so a
              // missing value never renders "undefined/10". Project rows are unchanged.
              const isLeadership = s.kind === "leadership";
              const scoreText = isLeadership
                ? `${(s.averageScore ?? s.totalScore / 10).toFixed(1)}/10`
                : `${s.totalScore}/100`;
              // The responder endpoint is restricted to the assigned super/PM or an admin/director, so the
              // affordance is TAPPABLE only when the server says this viewer can respond (else it 403s → a
              // load error). correctiveAffordance encodes all four (open/closed × can/can't) cases.
              const affordance = correctiveAffordance(s.status, s.canRespondToCorrectiveAction === true);
              // Derive the SPOKEN corrective wording from the same affordance value that drives the VISIBLE
              // affordance below (open_* → "required", closed_* → "resolved", none → silent) so screen-reader
              // semantics stay aligned with what's rendered rather than re-deriving from raw s.status.
              const correctiveA11y =
                affordance === "open_tappable" || affordance === "open_status"
                  ? ", corrective action required"
                  : affordance === "closed_tappable" || affordance === "closed_status"
                    ? ", corrective action resolved"
                    : "";
              return (
                <Pressable
                  key={s.id}
                  accessibilityRole="button"
                  accessibilityLabel={`${isLeadership ? "Leadership scorecard" : "Scorecard"}, week of ${formatShortDate(s.weekOf)}, ${scoreText}, ${s.ratingLabel}${correctiveA11y}`}
                  onPress={() => router.push({ pathname: "/(app)/scorecards/view/[id]", params: { id: s.id } })}
                  style={({ pressed }) => [styles.reportRow, pressed && { opacity: 0.7 }]}
                >
                  <View style={{ flex: 1, gap: 4 }}>
                    <Text style={styles.reportTitle} numberOfLines={1}>
                      {isLeadership ? "Leadership · " : ""}Week of {formatShortDate(s.weekOf)}
                      {s.submittedByName ? ` · ${s.submittedByName}` : ""}
                      {s.criticalDeficiencyCount > 0
                        ? ` · ${s.criticalDeficiencyCount} critical ${s.criticalDeficiencyCount === 1 ? "deficiency" : "deficiencies"}`
                        : ""}
                    </Text>
                    <RatingBadge rating={s.rating} label={`${scoreText} · ${s.ratingLabel}`} />
                    {/* Corrective-action affordance, gated on server authorization (canRespond). A viewer who
                        CAN respond gets a TAPPABLE prompt (open card) / "Resolved" badge (closed card) that
                        routes to the itemized response screen. A viewer who CANNOT respond sees the same
                        status as read-only text with NO route — the responder endpoint would 403 them, so
                        routing there would only produce a load error. Both tappable variants route to the
                        response screen (read-only for a resolved card), not the detail view. */}
                    {affordance === "open_tappable" ? (
                      <Pressable
                        accessibilityRole="button"
                        accessibilityLabel="Document the corrective action"
                        onPress={() => router.push({ pathname: "/(app)/scorecards/corrective-action/[id]", params: { id: s.id } })}
                        style={({ pressed }) => [styles.correctivePrompt, pressed && { opacity: 0.75 }]}
                      >
                        <Ionicons name="alert-circle" size={16} color={theme.color.brandRed} />
                        <Text style={styles.correctivePromptText}>Corrective action required</Text>
                        <Text style={styles.correctiveChevron}>›</Text>
                      </Pressable>
                    ) : affordance === "open_status" ? (
                      <View accessibilityRole="text" accessibilityLabel="Corrective action required" style={styles.correctiveStatus}>
                        <Ionicons name="alert-circle" size={16} color={theme.color.brandRed} />
                        <Text style={styles.correctivePromptText}>Corrective action required</Text>
                      </View>
                    ) : affordance === "closed_tappable" ? (
                      <Pressable
                        accessibilityRole="button"
                        accessibilityLabel="Review the resolved corrective action"
                        onPress={() => router.push({ pathname: "/(app)/scorecards/corrective-action/[id]", params: { id: s.id } })}
                        style={({ pressed }) => [styles.correctiveResolved, pressed && { opacity: 0.75 }]}
                      >
                        <Ionicons name="checkmark-circle" size={14} color="#166534" />
                        <Text style={styles.correctiveResolvedText}>Resolved</Text>
                        <Text style={styles.correctiveResolvedChevron}>›</Text>
                      </Pressable>
                    ) : affordance === "closed_status" ? (
                      <View accessibilityRole="text" accessibilityLabel="Corrective action resolved" style={styles.correctiveResolved}>
                        <Ionicons name="checkmark-circle" size={14} color="#166534" />
                        <Text style={styles.correctiveResolvedText}>Resolved</Text>
                      </View>
                    ) : null}
                  </View>
                </Pressable>
              );
            })
          )}
        </View>
      </ScrollView>

      {viewer !== null ? (
        <PhotoViewerModal photos={viewer.photos} initialIndex={viewer.index} visible projectDealId={dealId} onClose={() => setViewer(null)} />
      ) : null}

      <ReportBuilder
        visible={reportOpen}
        onClose={() => setReportOpen(false)}
        projectId={dealId}
        photos={filtered}
        voiceEnabled={voiceEnabled}
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
  correctivePrompt: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.space.xs,
    marginTop: theme.space.xs,
    paddingVertical: theme.space.xs,
    paddingHorizontal: theme.space.sm,
    borderRadius: theme.radius.sm,
    borderWidth: 1,
    borderColor: theme.color.brandRed,
    backgroundColor: "#FEF2F2",
    alignSelf: "flex-start",
  },
  correctivePromptText: { fontFamily: theme.font.semibold, fontSize: 13, color: theme.color.brandRed },
  correctiveChevron: { fontSize: 16, color: theme.color.brandRed, marginLeft: 2 },
  // Non-tappable open-status variant (no border/chevron) for a viewer who can't respond.
  correctiveStatus: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.space.xs,
    marginTop: theme.space.xs,
    alignSelf: "flex-start",
  },
  correctiveResolved: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    marginTop: theme.space.xs,
    alignSelf: "flex-start",
  },
  correctiveResolvedText: { fontFamily: theme.font.medium, fontSize: 12, color: "#166534" },
  correctiveResolvedChevron: { fontSize: 14, color: "#166534", marginLeft: 2 },
});
