import React, { useMemo, useState } from "react";
import { Image, Modal, Pressable, ScrollView, StyleSheet, Text, View, useWindowDimensions } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useAuth } from "../auth/AuthContext";
import { generateReport, previewReport } from "../api/endpoints";
import type { FieldPhoto, GeneratedReport, ReportGroupBy, ReportPreviewResponse } from "../api/types";
import { theme } from "../theme/theme";
import { Button, Chip, SectionLabel, TextInput } from "./ui";
import { Banner } from "./Banner";
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
          sections: preview.sections,
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
          <ScrollView contentContainerStyle={styles.body}>
            <View style={styles.rowBetween}>
              <SectionLabel>{selected.size} selected</SectionLabel>
              <Pressable onPress={toggleAll} hitSlop={8}>
                <Text style={styles.link}>{allSelected ? "Clear all" : "Select all"}</Text>
              </Pressable>
            </View>
            <View style={styles.grid}>
              {photos.map((photo) => {
                const isSelected = selected.has(photo.id);
                return (
                  <Pressable key={photo.id} onPress={() => toggle(photo.id)} style={{ width: cell, height: cell }}>
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
          </ScrollView>
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
            {preview?.sections.map((section) => (
              <View key={section.id} style={{ gap: theme.space.sm, marginTop: theme.space.lg }}>
                <SectionLabel>Section</SectionLabel>
                <TextInput
                  value={sectionTitles[section.id] ?? section.title}
                  onChangeText={(text) => setSectionTitles((prev) => ({ ...prev, [section.id]: text }))}
                  placeholder="Section title"
                />
                {section.photos.map((photo) => (
                  <View key={photo.id} style={styles.editPhoto}>
                    {photo.imageUrl ? (
                      <Image source={{ uri: photo.imageUrl }} style={styles.editThumb} resizeMode="cover" />
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
  groupRow: { flexDirection: "row", flexWrap: "wrap", gap: theme.space.sm },
  editPhoto: { flexDirection: "row", gap: theme.space.md, alignItems: "flex-start" },
  editThumb: { width: 72, height: 72, borderRadius: theme.radius.sm, backgroundColor: theme.color.surfaceMuted },
  footer: {
    padding: theme.space.lg,
    borderTopWidth: 1,
    borderTopColor: theme.color.border,
    backgroundColor: theme.color.surfaceCard,
  },
});
