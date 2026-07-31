import React, { useEffect, useRef, useState } from "react";
import { Modal, Pressable, ScrollView, StyleSheet, Text, View, useWindowDimensions } from "react-native";
import { Image as ExpoImage } from "expo-image";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { useAuth } from "../auth/AuthContext";
import { generateReport, getAiReportStatus, previewReport, startAiReport } from "../api/endpoints";
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

// Poll cadence for the async AI report. 3s is responsive without hammering the endpoint; the ceiling is
// generous because a 40-photo vision pass legitimately runs 30-90s and a cold worker can add to that.
const AI_POLL_INTERVAL_MS = 3_000;
const AI_POLL_TIMEOUT_MS = 5 * 60_000;
// Consecutive failed status requests tolerated before giving up (~15s of sustained outage at the 3s poll).
// A jobsite LTE connection drops individual requests routinely; one of those is not a failed report.
const AI_POLL_MAX_CONSECUTIVE_FAILURES = 5;
// Mirrors AI_REPORT_MAX_PHOTOS on the server. Enforced here too so "Select all" on a large project can't
// walk the user through the whole focus step only to be rejected at generation. Deliberately scoped to the
// AI action — the human preview/PDF flow has no such cap and must keep working on any selection.
const AI_REPORT_MAX_PHOTOS = 60;
// Mirrors MAX_FOCUS_PROMPT_LENGTH. The server slices to this; without the same cap here the user would see
// a complete scope statement while the assessment quietly dropped its final sentences.
const AI_FOCUS_MAX_LENGTH = 1000;

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
  onLeftRunning,
  voiceEnabled = false,
}: {
  visible: boolean;
  onClose: () => void;
  projectId: string;
  photos: FieldPhoto[];
  onGenerated: (report: GeneratedReport) => void;
  // Fired when this sheet STOPS waiting on a generation that is still running — the user closed the builder,
  // or the foreground poll hit its timeout. The job carries on server-side and files the report, but nothing
  // here is watching for it any more, so the owner has to follow it or the "it will appear in this project's
  // reports" promise is not kept until a manual pull-to-refresh. The RUN ID is handed over rather than a
  // bare signal: only the run itself says whether THIS report landed.
  onLeftRunning?: (runId: string) => void;
  // Gates the summary dictation button — true only when server transcription is configured, matching the
  // capture/scorecard surfaces. When false the summary is typing-only (no dead mic button).
  voiceEnabled?: boolean;
}) {
  const { fetcher } = useAuth();
  const { width } = useWindowDimensions();
  const cell = Math.floor((width - theme.space.lg * 2 - 8 * 2) / 3);

  // "focus" is the AI branch: select photos → state the focus → generate. Kept as its own step rather than
  // an inline box on "select" so the existing Preview flow isn't cluttered by a control it never uses.
  const [step, setStep] = useState<"select" | "focus" | "edit">("select");
  const [focusPrompt, setFocusPrompt] = useState("");
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
  // Separate from `busy` on purpose: they drive two different footer buttons, and sharing one flag would
  // spin the Preview button for an AI request that has nothing to do with it.
  const [aiBusy, setAiBusy] = useState(false);
  const [aiProgress, setAiProgress] = useState<string | null>(null);
  // Generation token, not a boolean. A ref because the poll loop closes over it and must observe a cancel
  // that happens mid-await — a state value captured at loop entry never would. A monotonically increasing
  // token rather than a flag because a shared boolean can be set back to true by a NEWLY started report
  // while an older loop is still resolving a request: the stale loop would resume as if it were current and
  // could open the previous PDF, close the new sheet, or clear the flag in its own `finally` and silently
  // kill the live loop. Each run captures its own token and stops the moment it is no longer the current one.
  const aiRunTokenRef = useRef(0);
  // The run this sheet is currently watching, or null. Distinct from the token (which only says "this loop
  // is current") because the hand-off has to fire exactly once, only for a run that never reached a terminal
  // state, and it has to name WHICH run so the owner can follow that one specifically.
  const aiRunIdRef = useRef<string | null>(null);
  // Set when a run was handed to the background watcher while this sheet STAYED OPEN — the poll timed out,
  // or gave up after a sustained outage. `finally` clears aiBusy on both paths, which put a live Generate
  // button in front of a user whose report is still being written; tapping it buys a second paid assessment
  // for work already in flight. Cleared by reset(), so closing and deliberately coming back starts fresh.
  const [handedOffToBackground, setHandedOffToBackground] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Cancelling through close()/Cancel bumps the token, but an UNMOUNT never runs either — navigating off the
  // project screen mid-run left the loop polling, and it could still call onGenerated (reopening a PDF on a
  // screen the user has left) or setState on a component that is gone. Invalidate on teardown too.
  useEffect(() => () => {
    aiRunTokenRef.current += 1;
  }, []);

  function reset() {
    setStep("select");
    setSelected(new Set());
    setGroupBy("none");
    setPreview(null);
    setSections([]);
    setTitle("");
    setFocusPrompt("");
    setExecSummary("");
    setSummaryDictating(false);
    setSectionTitles({});
    setDescriptions({});
    setError(null);
    setBusy(false);
    // Hand the run off BEFORE invalidating the loop: the job carries on and files its report, but nothing
    // here will see it land, so the owner has to keep the report list fresh for that to be true.
    const handOff = aiRunIdRef.current;
    if (handOff) {
      aiRunIdRef.current = null;
      onLeftRunning?.(handOff);
    }
    // Invalidate any in-flight poll loop. The server-side job keeps running — the finished report still
    // lands in the project's report list — but this sheet stops waiting on it.
    aiRunTokenRef.current += 1;
    setAiBusy(false);
    setAiProgress(null);
    setHandedOffToBackground(false);
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
   * Kick off an AI-authored condition assessment and wait for it.
   *
   * The work is async server-side (a Claude vision pass over every selected photo runs far longer than any
   * request timeout), so this enqueues a run and polls its status. Success reuses the SAME onGenerated
   * handler as "Generate PDF" — the status endpoint returns an identically shaped `report` — so the toast,
   * the report-list refresh and opening the PDF all stay in one place.
   */
  async function runAiReport() {
    if (selected.size === 0 || aiBusy) return;
    setError(null);
    setAiBusy(true);
    setAiProgress("Starting the assessment…");
    // Claim a token; any earlier loop still resolving is now stale and will stop on its next check.
    const runToken = ++aiRunTokenRef.current;
    const isCurrent = () => aiRunTokenRef.current === runToken;
    const startedAt = Date.now();
    try {
      const { runId } = await startAiReport(fetcher, {
        projectId,
        photoIds: Array.from(selected),
        focusPrompt: focusPrompt.trim() || undefined,
      });
      // Checked BEFORE the progress text is written, not after. reset() has already cleared aiProgress and
      // invalidated this token, and the `finally` below deliberately leaves stale state alone — so setting
      // it here first would strand "Reviewing …" on the sheet, still showing the next time it is opened.
      if (!isCurrent()) {
        // Closed (or superseded) DURING the enqueue. reset() already ran, and it saw no run to hand off
        // because the id did not exist yet — but the server committed one, so a real generation is now
        // running with nothing watching it. Hand it over here instead of dropping it.
        onLeftRunning?.(runId);
        return;
      }
      // From here the job exists server-side and will finish whether or not this sheet is still watching.
      aiRunIdRef.current = runId;
      setAiProgress(
        `Reviewing ${selected.size} photo${selected.size === 1 ? "" : "s"}… this usually takes about a minute.`,
      );
      let consecutiveFailures = 0;
      while (isCurrent()) {
        await new Promise((resolve) => setTimeout(resolve, AI_POLL_INTERVAL_MS));
        if (!isCurrent()) return; // cancelled (sheet closed) while waiting

        let status;
        try {
          status = await getAiReportStatus(fetcher, runId);
          consecutiveFailures = 0;
        } catch (pollError) {
          // A dropped poll is not a failed report. On jobsite LTE a single request will lose packets during
          // a 60-90s wait; treating that as terminal would tell the user their report failed while it is in
          // fact still running and about to file. Only a sustained outage gives up.
          consecutiveFailures += 1;
          if (consecutiveFailures >= AI_POLL_MAX_CONSECUTIVE_FAILURES) throw pollError;
          continue;
        }

        // Re-check AFTER the await: the request can be in flight for seconds, and the user may have closed
        // the sheet in that window. Without this, cancelling still fires onGenerated and reopens the PDF.
        if (!isCurrent()) return;

        if (status.status === "succeeded" && status.report) {
          // Terminal, and this sheet saw it — nothing to hand off.
          aiRunIdRef.current = null;
          onGenerated(status.report);
          close();
          return;
        }
        if (status.status === "failed") {
          aiRunIdRef.current = null;
          throw new Error(status.error || "The AI report could not be generated.");
        }
        if (Date.now() - startedAt > AI_POLL_TIMEOUT_MS) {
          // Stop waiting, but do NOT claim it failed — the job may still finish and file the report. Hand it
          // off here rather than at reset(): the sheet stays open on this error, so close() may not run for a
          // long time, and the message below promises the report will turn up on its own.
          aiRunIdRef.current = null;
          setHandedOffToBackground(true);
          onLeftRunning?.(runId);
          throw new Error(
            "This is taking longer than expected. The report will appear in this project's reports when it finishes.",
          );
        }
      }
    } catch (e) {
      // The loop stopped without the run reaching a terminal state — a sustained polling outage is the usual
      // way here. The generation is still going, so hand it to the background watcher exactly as the timeout
      // path does; otherwise nothing refreshes the finished report, and a retry from the re-enabled Generate
      // button would buy a second paid assessment for work that already completed. (The timeout and
      // terminal-status paths clear the id first, so this cannot fire twice for one run.)
      const abandoned = aiRunIdRef.current;
      if (abandoned) {
        aiRunIdRef.current = null;
        setHandedOffToBackground(true);
        onLeftRunning?.(abandoned);
      }
      // A stale loop must not report ITS failure over a run the user has since started, or paint an error
      // onto a sheet that has already moved on.
      if (isCurrent()) setError(e instanceof Error ? e.message : "Could not generate the AI report.");
    } finally {
      // Only the CURRENT run owns this UI state. A stale loop unwinding here would clear the live run's
      // spinner and progress text, leaving a generation in flight with no indication it is running.
      if (isCurrent()) {
        setAiBusy(false);
        setAiProgress(null);
      }
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

  const headerTitle = step === "select" ? "Build report" : step === "focus" ? "AI report" : "Edit report";

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
              if (step === "edit" || step === "focus") setStep("select");
              else close();
            }}
            disabled={summaryDictating}
            hitSlop={10}
          >
            <Text style={[styles.headerAction, summaryDictating && styles.headerActionDisabled]}>
              {step === "select" ? "Cancel" : "Back"}
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

        {step === "focus" ? (
          <ScrollView contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled">
            <SectionLabel>What should this report focus on?</SectionLabel>
            <Text style={styles.hint}>
              Optional. Leave it blank and you'll get a director's general read of everything captured.
            </Text>
            <TextInput
              value={focusPrompt}
              onChangeText={setFocusPrompt}
              placeholder="e.g. Roof drainage and flashing only — the interior punch list is already handled"
              multiline
              // Same cap the server applies. Without it the user sees a complete scope statement while the
              // assessment quietly drops everything past the limit.
              maxLength={AI_FOCUS_MAX_LENGTH}
              style={styles.summaryInput}
            />
            {focusPrompt.length > AI_FOCUS_MAX_LENGTH - 100 ? (
              <Text style={styles.hint}>
                {AI_FOCUS_MAX_LENGTH - focusPrompt.length} characters left.
              </Text>
            ) : null}
            {voiceEnabled ? (
              <VoiceRecorder
                label="🎤 Dictate focus"
                onBusyChange={setSummaryDictating}
                onTranscript={(text) =>
                  // Dictation appends programmatically, so the input's maxLength does not apply — cap here
                  // too or a long dictated scope silently overruns what the server will actually read.
                  setFocusPrompt((prev) =>
                    (prev.trim() ? `${prev.trim()} ${text}` : text).slice(0, AI_FOCUS_MAX_LENGTH),
                  )
                }
              />
            ) : null}
            {/* Sets expectations for the two behaviours people are most likely to be surprised by: their
                captions are used as input, and a photo with nothing to say keeps its caption unchanged. */}
            <Text style={[styles.hint, styles.focusNote]}>
              All {selected.size} selected photo{selected.size === 1 ? "" : "s"} will appear in the report. Their
              existing captions are given to the AI as field notes, and any photo with nothing relevant to say
              about it keeps its caption exactly as it is.
            </Text>
          </ScrollView>
        ) : step === "select" ? (
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
            <>
              {/* Button's `loading` swaps the label for a bare spinner, so the "what is it doing / how long"
                  copy has to live outside it. */}
              {aiProgress ? <Text style={styles.aiProgress}>{aiProgress}</Text> : null}
              {/* Say WHY the AI action is unavailable — a silently disabled button reads as a bug. */}
              {selected.size > AI_REPORT_MAX_PHOTOS ? (
                <Text style={styles.aiProgress}>
                  An AI report covers up to {AI_REPORT_MAX_PHOTOS} photos — deselect{" "}
                  {selected.size - AI_REPORT_MAX_PHOTOS} to use it.
                </Text>
              ) : null}
              <View style={styles.footerRow}>
                <Button
                  title="Preview report"
                  onPress={runPreview}
                  loading={busy}
                  disabled={selected.size === 0 || aiBusy}
                  style={styles.footerButton}
                />
                <Button
                  title="AI Report"
                  variant="ghost"
                  icon={<Ionicons name="sparkles-outline" size={16} color={theme.color.brandRed} />}
                  onPress={() => setStep("focus")}
                  disabled={selected.size === 0 || selected.size > AI_REPORT_MAX_PHOTOS || busy}
                  style={styles.footerButton}
                />
              </View>
            </>
          ) : step === "focus" ? (
            <>
              {aiProgress ? <Text style={styles.aiProgress}>{aiProgress}</Text> : null}
              {handedOffToBackground ? (
                <Text style={styles.aiProgress}>
                  That report is still being written and will appear in this project&apos;s reports when it
                  finishes. Starting another would generate a second one.
                </Text>
              ) : null}
              <Button
                title="Generate AI report"
                icon={<Ionicons name="sparkles-outline" size={16} color="#FFFFFF" />}
                onPress={runAiReport}
                loading={aiBusy}
                // Blocked while a handed-off run is still going: `finally` has cleared aiBusy, so without
                // this the button is live again and a second tap pays for the same report twice.
                disabled={summaryDictating || handedOffToBackground}
              />
            </>
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
  footerRow: { flexDirection: "row", gap: theme.space.md },
  focusNote: { marginTop: theme.space.lg },
  // flexBasis:0 with flexGrow:1 so the two buttons split the bar evenly regardless of label width —
  // plain flex:1 alone lets the longer title ("Preview report") claim more of the row.
  footerButton: { flexGrow: 1, flexBasis: 0 },
  aiProgress: {
    fontFamily: theme.font.body,
    fontSize: 13,
    color: theme.color.textMuted,
    marginBottom: theme.space.sm,
    textAlign: "center",
  },
});
