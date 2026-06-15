import React, { useEffect, useState } from "react";
import {
  Alert,
  Image,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
} from "react-native";
import { SafeAreaProvider, SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { theme } from "../theme/theme";
import type { SessionPhoto } from "../capture/session-photo";
import { Button } from "./ui";
import { PhotoCaptionEditor } from "./PhotoCaptionEditor";

const GAP = 8;
const COLUMNS = 3;
const H_PADDING = theme.space.lg;

/**
 * Review tray: a grid of captured/imported photos. Tapping a photo opens a
 * bottom-sheet editor (always adjacent, regardless of how far the grid scrolls)
 * to caption it individually — optional; uncaptioned photos inherit the batch
 * caption at upload. A captioned photo is marked with a pencil badge.
 */
export function ReviewTray({
  photos,
  onSetCaption,
  onAppendCaption,
  onRemove,
  disabled = false,
  voiceEnabled = false,
}: {
  photos: SessionPhoto[];
  onSetCaption: (key: string, text: string) => void;
  onAppendCaption: (key: string, text: string) => void;
  onRemove: (key: string) => void;
  disabled?: boolean;
  voiceEnabled?: boolean;
}) {
  const { width } = useWindowDimensions();
  const size = Math.floor((width - H_PADDING * 2 - GAP * (COLUMNS - 1)) / COLUMNS);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const selected = photos.find((p) => p.key === selectedKey) ?? null;
  // Block closing the caption sheet while dictation is recording/transcribing — closing
  // would unmount VoiceRecorder mid-flight and drop the dictated caption.
  const [voiceBusy, setVoiceBusy] = useState(false);
  useEffect(() => setVoiceBusy(false), [selectedKey]);
  function closeSheet() {
    if (voiceBusy) return;
    setSelectedKey(null);
  }

  function confirmRemove(key: string) {
    Alert.alert("Remove photo", "Remove this photo from the batch?", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Remove",
        style: "destructive",
        onPress: () => {
          onRemove(key);
          setSelectedKey(null);
        },
      },
    ]);
  }

  return (
    <View style={{ gap: theme.space.md }}>
      {/* The grid dims while an upload is in flight so the whole captured set reads as locked. */}
      <View style={[styles.grid, disabled && styles.gridDisabled]}>
        {photos.map((photo) => {
          const isSelected = photo.key === selectedKey;
          const hasCaption = photo.caption.trim().length > 0;
          return (
            <Pressable
              key={photo.key}
              onPress={() => setSelectedKey(photo.key)}
              disabled={disabled}
              accessibilityRole="button"
              accessibilityState={{ selected: isSelected }}
              accessibilityLabel={hasCaption ? "Photo (captioned) — edit caption" : "Photo — add caption"}
              style={{ width: size, height: size }}
            >
              <Image source={{ uri: photo.uri }} style={styles.thumb} />
              {hasCaption ? (
                <View style={styles.captionBadge}>
                  <Ionicons name="pencil" size={12} color={theme.color.brandRed} />
                </View>
              ) : null}
            </Pressable>
          );
        })}
      </View>

      <Text style={styles.tapHint}>Tap a photo to caption it (optional).</Text>

      <Modal
        visible={selected !== null}
        animationType="slide"
        transparent
        onRequestClose={closeSheet}
      >
        {/* Own SafeAreaProvider: a Modal is a separate window, so the sheet's bottom
            inset (home indicator) only resolves with a provider inside the Modal. */}
        <SafeAreaProvider>
          {/* KeyboardAvoidingView lifts the (multiline) caption + Done above the keyboard;
              InputAccessoryView is NOT used here — RN's accessory doesn't support multiline. */}
          <KeyboardAvoidingView style={styles.modalRoot} behavior={Platform.OS === "ios" ? "padding" : undefined}>
            <Pressable style={styles.backdrop} onPress={closeSheet} accessibilityLabel="Close caption editor" />
            {selected ? (
              <SafeAreaView edges={["bottom"]} style={styles.sheet}>
                {/* Shared editor body; functional append in the parent avoids overwriting on rapid
                    transcripts, and while dictation is recording/transcribing the sheet is held open
                    (closeSheet/Done are guarded by voiceBusy). */}
                <PhotoCaptionEditor
                  uri={selected.uri}
                  caption={selected.caption}
                  onChangeCaption={(text) => onSetCaption(selected.key, text)}
                  onAppendCaption={(text) => onAppendCaption(selected.key, text)}
                  voiceEnabled={voiceEnabled}
                  onBusyChange={setVoiceBusy}
                  disabled={disabled}
                  autoFocus
                  hint="Optional — leave blank to use the shared caption below."
                  headerRight={
                    <Pressable
                      onPress={() => confirmRemove(selected.key)}
                      disabled={disabled || voiceBusy}
                      hitSlop={12}
                      accessibilityRole="button"
                      accessibilityLabel="Remove photo"
                    >
                      <Text style={[styles.remove, (disabled || voiceBusy) && styles.removeDisabled]}>Remove</Text>
                    </Pressable>
                  }
                  footer={<Button title="Done" onPress={closeSheet} disabled={voiceBusy} />}
                />
              </SafeAreaView>
            ) : null}
          </KeyboardAvoidingView>
        </SafeAreaProvider>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  grid: { flexDirection: "row", flexWrap: "wrap", gap: GAP },
  gridDisabled: { opacity: 0.5 },
  thumb: { width: "100%", height: "100%", borderRadius: theme.radius.sm, backgroundColor: theme.color.surfaceMuted },
  // White badge w/ a red pencil — distinct from any selection accent (no more red-on-red).
  captionBadge: {
    position: "absolute",
    top: 4,
    left: 4,
    width: 22,
    height: 22,
    borderRadius: 11,
    backgroundColor: theme.color.surfaceCard,
    borderWidth: 1,
    borderColor: theme.color.border,
    alignItems: "center",
    justifyContent: "center",
  },
  tapHint: { fontFamily: theme.font.body, fontSize: 13, color: theme.color.textMuted },
  modalRoot: { flex: 1, justifyContent: "flex-end" },
  backdrop: { ...StyleSheet.absoluteFillObject, backgroundColor: "rgba(15,17,21,0.45)" },
  sheet: {
    backgroundColor: theme.color.surfaceCard,
    borderTopLeftRadius: theme.radius.lg,
    borderTopRightRadius: theme.radius.lg,
    padding: theme.space.lg,
    gap: theme.space.md,
  },
  remove: { fontFamily: theme.font.semibold, fontSize: 14, color: theme.color.danger },
  removeDisabled: { opacity: 0.4 },
});
