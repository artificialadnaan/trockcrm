import React from "react";
import { StyleSheet, Text, View } from "react-native";
import { Image as ExpoImage } from "expo-image";
import { theme } from "../theme/theme";
import { TextInput } from "./ui";
import { VoiceRecorder } from "./VoiceRecorder";

/**
 * The per-photo caption/voice editor body — a thumbnail of the photo, a multiline
 * description field, and one-tap voice dictation. Extracted from the review-tray
 * sheet so the SAME editor is reused in two places: the review tray's bottom sheet
 * (caption a photo after a burst) and the live camera's after-each-shot prompt
 * (document-as-you-go). The wrapper (Modal sheet vs. in-camera overlay) and the
 * footer actions (Done vs. Save & next / Skip) are supplied by the caller — this
 * component only owns the shared editor body.
 */
export function PhotoCaptionEditor({
  uri,
  caption,
  onChangeCaption,
  onAppendCaption,
  voiceEnabled = false,
  onBusyChange,
  disabled = false,
  autoFocus = false,
  label = "Caption for this photo",
  hint,
  headerRight,
  footer,
}: {
  uri: string;
  caption: string;
  onChangeCaption: (text: string) => void;
  /** Append a (voice) transcript to the caption — functional so rapid transcripts don't clobber. */
  onAppendCaption: (text: string) => void;
  voiceEnabled?: boolean;
  onBusyChange?: (busy: boolean) => void;
  disabled?: boolean;
  autoFocus?: boolean;
  label?: string;
  hint?: string;
  /** Optional trailing control in the header row (e.g. Remove). */
  headerRight?: React.ReactNode;
  /** Action buttons under the editor (e.g. Done, or Save & next / Skip). */
  footer?: React.ReactNode;
}) {
  return (
    <>
      <View style={styles.head}>
        <ExpoImage
          testID="caption-photo-image"
          source={{ uri }}
          style={styles.thumb}
          contentFit="cover"
          recyclingKey={uri}
          cachePolicy="memory-disk"
        />
        <View style={{ flex: 1 }}>
          <Text style={styles.label}>{label}</Text>
          {hint ? <Text style={styles.hint}>{hint}</Text> : null}
        </View>
        {headerRight ?? null}
      </View>
      <TextInput
        value={caption}
        onChangeText={onChangeCaption}
        editable={!disabled}
        placeholder="Describe this photo"
        accessibilityLabel="Photo caption"
        multiline
        autoFocus={autoFocus}
        style={styles.input}
      />
      {voiceEnabled ? <VoiceRecorder onTranscript={onAppendCaption} onBusyChange={onBusyChange} /> : null}
      {footer ?? null}
    </>
  );
}

const styles = StyleSheet.create({
  head: { flexDirection: "row", alignItems: "center", gap: theme.space.md },
  thumb: { width: 48, height: 48, borderRadius: theme.radius.sm, backgroundColor: theme.color.surfaceMuted },
  label: { fontFamily: theme.font.semibold, fontSize: 14, color: theme.color.textPrimary },
  hint: { fontFamily: theme.font.body, fontSize: 12, color: theme.color.textMuted },
  input: { minHeight: 80, textAlignVertical: "top", paddingTop: 10, paddingBottom: 10 },
});
