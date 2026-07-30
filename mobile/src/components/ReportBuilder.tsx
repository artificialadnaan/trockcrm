import React, { useState } from "react";
import { Modal, Pressable, ScrollView, StyleSheet, Text, View, useWindowDimensions } from "react-native";
import { Image as ExpoImage } from "expo-image";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { useAuth } from "../auth/AuthContext";
import { generateReport, previewReport } from "../api/endpoints";
import type {
  FieldPhoto,
  FieldReportSection,
  GeneratedReport,
  ReportGroupBy,
  ReportPreviewResponse,
} from "../api/types";
import { theme } from "../theme/theme";
import { Button, Chip, SectionLabel, TextInput } from "./ui";
import { Banner } from "./Banner";
import { PhotoPickerGrid } from "./PhotoPickerGrid";
import { VoiceRecorder } from "./VoiceRecorder";
import { buildGenerateReportRequest } from "./report-builder-request";

const GROUP_OPTIONS: { value: ReportGroupBy; label: string }[] = [
  { value: "none", label: "No grouping" },
  { value: "tag", label: "By tag" },
  { value: "date", label: "By date" },
];

/**
 * Two-step photo report flow mirroring client-field ReportBuilder:
 *   select photos + group-by → preview → edit titles / per-photo descriptions →
 *   generate a branded PDF (preview→generate endpoints).
 */
export function ReportBuilder({
  visible,
  onClose,
  projectId,
  photos,
  onGenerated,
  voiceEnabled = false,
}: {
  visible: boolean;
  onClose: () => void;
  projectId: string;
  photos: FieldPhoto[];
  onGenerated: (report: GeneratedReport) => void;
  // Gates the summary dictation button — true only when server transcription is configured, matching the
  // capture/scorecard surfaces. When false the summary is typing-only (no dead mic button).
  voiceEnabled?: boolean;
}) {
  const { fetcher } = useAuth();
  const { width } = useWindowDimensions();
  const cell = Math.floor((width - theme.space.lg * 2 - 8 * 2) / 3);

  const [step, setStep] = useState<"select" | "edit">("select");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [groupBy, setGroupBy] = useState<ReportGroupBy>("none");
  const [preview, setPreview] = useState<ReportPreviewResponse | null>(null);
  // A MUTABLE copy of the previewed sections — the order here is the order the PDF is printed in. Both
  // endpoints reindex by the client's photoIds array rather than re-sorting, and the "Photo N" badge is a
  // running counter over that same array, so reordering here renumbers the PDF correctly for free.
  // Kept separate from `preview` so the untouched server response stays available for the cover data.
  const [sections, setSections] = useState<FieldReportSection[]>([]);
  const [title, setTitle] = useState("");
  const [execSummary, setExecSummary] = useState("");
  // Held while the summary is being dictated/transcribed so Generate can't fire and drop the transcript.
  const [summaryDictating, setSummaryDictating] = useState(false);
  const [sectionTitles, setSectionTitles] = useState<Record<string, string>>({});
  const [descriptions, setDescriptions] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function reset() {
    setStep("select");
    setSelected(new Set());
    setGroupBy("none");
    setPreview(null);
    setSections([]);
    setTitle("");
    setExecSummary("");
    setSummaryDictating(false);
    setSectionTitles({});
    setDescriptions({});
    setError(null);
    setBusy(false);
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

  async function runPreview() {
    setError(null);
    setBusy(true);
    try {
      const result = await previewReport(fetcher, {
        projectId,
        photoIds: Array.from(selected),
        groupBy,
      });
      setPreview(result);
      setSections(result.sections);
      setTitle(result.cover.reportTitle);
      const initialDescriptions: Record<string, string> = {};
      for (const section of result.sections) {
        for (const photo of section.photos) initialDescriptions[photo.id] = photo.description ?? "";
      }
      setDescriptions(initialDescriptions);
      setSectionTitles(Object.fromEntries(result.sections.map((s) => [s.id, s.title])));
      setStep("edit");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not build the preview.");
    } finally {
      setBusy(false);
    }
  }

  /**
   * Move one photo a single position within its section. Mirrors the web builder's reorderPhoto: splice the
   * photo out and back in at index+direction, leaving every other photo's relative order untouched. Bounds
   * are a no-op rather than a wrap, and the controls are disabled at the ends anyway.
   *
   * Up/down controls rather than drag-and-drop deliberately: every mainstream RN drag-list needs
   * react-native-reanimated, which this app does not have — adding it means a new native dependency in an
   * app CI never compiles. Tap targets also beat a drag gesture on a jobsite, in gloves.
   */
  function reorderPhoto(sectionId: string, photoId: string, direction: -1 | 1) {
    setSections((current) =>
      current.map((section) => {
        if (section.id !== sectionId) return section;
        const index = section.photos.findIndex((photo) => photo.id === photoId);
        if (index < 0) return section;
        const nextIndex = index + direction;
        if (nextIndex < 0 || nextIndex >= section.photos.length) return section;
        const photos = [...section.photos];
        const [moved] = photos.splice(index, 1);
        photos.splice(nextIndex, 0, moved);
        return { ...section, photos };
      }),
    );
  }

  async function runGenerate() {
    if (!preview) return;
    setError(null);
    setBusy(true);
    try {
      const result = await generateReport(
        fetcher,
        buildGenerateReportRequest({
          projectId,
          reportTitle: title,
          executiveSummary: execSummary,
          cover: preview.cover,
          // The reordered copy, not the server's original — this is what carries the user's ordering.
          sections,
          sectionTitles,
          descriptions,
        }),
      );
      onGenerated(result.report);
      close();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not generate the report.");
    } finally {
      setBusy(false);
    }
  }

  const headerTitle = step === "select" ? "Build report" : "Edit report";

  return (
    <Modal
      visible={visible}
      animationType="slide"
      // Don't tear the sheet down (and drop the in-flight transcript) while dictation is running.
      onRequestClose={() => {
        if (!summaryDictating) close();
      }}
      presentationStyle="pageSheet"
    >
      <SafeAreaView style={styles.container} edges={["top", "bottom"]}>
        <View style={styles.header}>
          <Pressable
            // Guarded like ReviewTray: a mid-dictation Back/Cancel would unmount VoiceRecorder and lose the
            // transcript, so block teardown until dictation settles.
            onPress={() => {
              if (summaryDictating) return;
              if (step === "edit") setStep("select");
              else close();
            }}
            disabled={summaryDictating}
            hitSlop={10}
          >
            <Text style={[styles.headerAction, summaryDictating && styles.headerActionDisabled]}>
              {step === "edit" ? "Back" : "Cancel"}
            </Text>
          </Pressable>
          <Text style={styles.headerTitle}>{headerTitle}</Text>
          <View style={{ width: 56 }} />
        </View>

        {error ? (
          <View style={{ paddingHorizontal: theme.space.lg }}>
            <Banner message={error} />
          </View>
        ) : null}

        {step === "select" ? (
          <PhotoPickerGrid
            photos={photos}
            selected={selected}
            onToggle={toggle}
            cellSize={cell}
            header={
              <View style={[styles.rowBetween, styles.gridHeader]}>
                <SectionLabel>{selected.size} selected</SectionLabel>
                <Pressable onPress={toggleAll} hitSlop={8}>
                  <Text style={styles.link}>{allSelected ? "Clear all" : "Select all"}</Text>
                </Pressable>
              </View>
            }
            footer={
              <View style={styles.gridFooter}>
                <SectionLabel>Group photos</SectionLabel>
                <View style={styles.groupRow}>
                  {GROUP_OPTIONS.map((option) => (
                    <Chip
                      key={option.value}
                      label={option.label}
                      selected={groupBy === option.value}
                      onPress={() => setGroupBy(option.value)}
                    />
                  ))}
                </View>
              </View>
            }
          />
        ) : (
          <ScrollView contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled">
            <SectionLabel>Report title</SectionLabel>
            <TextInput value={title} onChangeText={setTitle} placeholder="Report title" />

            <SectionLabel>Executive summary</SectionLabel>
            <Text style={styles.hint}>Optional — appears right after the cover page.</Text>
            <TextInput
              value={execSummary}
              onChangeText={setExecSummary}
              placeholder="Summarize the project status, wins, and next steps…"
              multiline
              style={styles.summaryInput}
            />
            {voiceEnabled ? (
              <VoiceRecorder
                label="🎤 Dictate summary"
                onBusyChange={setSummaryDictating}
                onTranscript={(text) =>
                  setExecSummary((prev) => (prev.trim() ? `${prev.trim()} ${text}` : text))
                }
              />
            ) : null}
            {sections.map((section) => (
              <View key={section.id} style={{ gap: theme.space.sm, marginTop: theme.space.lg }}>
                <SectionLabel>Section</SectionLabel>
                <TextInput
                  value={sectionTitles[section.id] ?? section.title}
                  onChangeText={(text) => setSectionTitles((prev) => ({ ...prev, [section.id]: text }))}
                  placeholder="Section title"
                />
                {/* The PDF prints 3 photos per page in exactly this order, so the position number is the
                    page-composition control, not decoration. */}
                <Text style={styles.hint}>Photos print in this order — use ↑ ↓ to rearrange.</Text>
                {section.photos.map((photo, photoIndex) => (
                  <View key={photo.id} style={styles.editPhoto}>
                    {photo.imageUrl ? (
                      <ExpoImage
                        source={{ uri: photo.imageUrl }}
                        style={styles.editThumb}
                        contentFit="cover"
                        cachePolicy="memory-disk"
                        recyclingKey={photo.id}
                        transition={80}
                      />
                    ) : (
                      <View style={[styles.editThumb, styles.placeholder]} />
                    )}
                    <TextInput
                      value={descriptions[photo.id] ?? ""}
                      onChangeText={(text) => setDescriptions((prev) => ({ ...prev, [photo.id]: text }))}
                      placeholder="Caption / description"
                      multiline
                      style={{ flex: 1, minHeight: 64, textAlignVertical: "top", paddingTop: 10 }}
                    />
                    <View style={styles.reorderColumn}>
                      <Text style={styles.reorderPosition}>
                        {photoIndex + 1}/{section.photos.length}
                      </Text>
                      <Pressable
                        onPress={() => reorderPhoto(section.id, photo.id, -1)}
                        disabled={photoIndex === 0}
                        hitSlop={2}
                        accessibilityRole="button"
                        // Leads with the POSITION because displayName is not unique — names seed from the
                        // uploader's filename and are freely editable, so a section routinely holds two
                        // photos called IMG_0001. Position first also matches what the control does.
                        accessibilityLabel={`Move photo ${photoIndex + 1} of ${section.photos.length} earlier, ${photo.displayName}`}
                        style={({ pressed }) => [
                          styles.reorderButton,
                          photoIndex === 0 && styles.reorderButtonDisabled,
                          pressed && { opacity: 0.6 },
                        ]}
                      >
                        <Ionicons
                          name="chevron-up"
                          size={18}
                          color={photoIndex === 0 ? theme.color.textMuted : theme.color.brandRed}
                        />
                      </Pressable>
                      <Pressable
                        onPress={() => reorderPhoto(section.id, photo.id, 1)}
                        disabled={photoIndex === section.photos.length - 1}
                        hitSlop={2}
                        accessibilityRole="button"
                        accessibilityLabel={`Move photo ${photoIndex + 1} of ${section.photos.length} later, ${photo.displayName}`}
                        style={({ pressed }) => [
                          styles.reorderButton,
                          photoIndex === section.photos.length - 1 && styles.reorderButtonDisabled,
                          pressed && { opacity: 0.6 },
                        ]}
                      >
                        <Ionicons
                          name="chevron-down"
                          size={18}
                          color={
                            photoIndex === section.photos.length - 1 ? theme.color.textMuted : theme.color.brandRed
                          }
                        />
                      </Pressable>
                    </View>
                  </View>
                ))}
              </View>
            ))}
          </ScrollView>
        )}

        <View style={styles.footer}>
          {step === "select" ? (
            <Button
              title="Preview report"
              onPress={runPreview}
              loading={busy}
              disabled={selected.size === 0}
            />
          ) : (
            <Button title="Generate PDF" onPress={runGenerate} loading={busy} disabled={summaryDictating} />
          )}
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
  headerActionDisabled: { opacity: 0.4 },
  body: { padding: theme.space.lg, gap: theme.space.md, paddingBottom: theme.space.xxl },
  rowBetween: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  link: { fontFamily: theme.font.semibold, fontSize: 14, color: theme.color.brandRed },
  hint: { fontFamily: theme.font.body, fontSize: 13, color: theme.color.textMuted, marginTop: -4 },
  summaryInput: { minHeight: 110, textAlignVertical: "top", paddingTop: 10 },
  placeholder: { borderWidth: 1, borderColor: theme.color.border },
  gridHeader: { marginBottom: theme.space.md },
  gridFooter: { marginTop: theme.space.lg, gap: theme.space.sm },
  groupRow: { flexDirection: "row", flexWrap: "wrap", gap: theme.space.sm },
  editPhoto: { flexDirection: "row", gap: theme.space.md, alignItems: "flex-start" },
  // The gap must stay WIDER than twice the buttons' hitSlop, or the two slop rectangles overlap and the
  // later sibling (down) claims the shared band — including part of the up button's own visible frame, so a
  // tap aimed at the bottom of "up" would move the photo DOWN. gap 8 vs hitSlop 2 leaves 4pt of clearance.
  reorderColumn: { alignItems: "center", gap: theme.space.sm, paddingTop: 2 },
  reorderPosition: { fontFamily: theme.font.semibold, fontSize: 11, color: theme.color.textMuted },
  reorderButton: {
    // 44x40 + 2pt slop on each side = a 48x44 touch target, the iOS minimum. These get used in gloves.
    width: 44,
    height: 40,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: theme.radius.sm,
    borderWidth: 1,
    borderColor: theme.color.border,
  },
  reorderButtonDisabled: { opacity: 0.4 },
  editThumb: { width: 72, height: 72, borderRadius: theme.radius.sm, backgroundColor: theme.color.surfaceMuted },
  footer: {
    padding: theme.space.lg,
    borderTopWidth: 1,
    borderTopColor: theme.color.border,
    backgroundColor: theme.color.surfaceCard,
  },
});
