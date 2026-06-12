import React from "react";
import { InputAccessoryView, Keyboard, Platform, Pressable, StyleSheet, Text, View } from "react-native";
import { theme } from "../theme/theme";

// Shared IDs so a TextInput can opt into the Done toolbar via inputAccessoryViewID.
// Two IDs: one for the main app windows (batch caption, login) and one for the
// per-photo bottom-sheet, which is a separate Modal window — keeping them distinct
// avoids any same-id collision when both are mounted on the capture screen.
export const KEYBOARD_ACCESSORY_ID = "trockcam-kbd-done";
export const KEYBOARD_ACCESSORY_ID_SHEET = "trockcam-kbd-done-sheet";

/**
 * iOS keyboard toolbar with a single "Done" button that dismisses the keyboard.
 * Multiline caption fields make the return key a newline, so this is the reliable
 * way to dismiss them (and to free an action button the keyboard would cover).
 * iOS-only — renders nothing elsewhere (this app is iOS-only).
 */
export function KeyboardDoneAccessory({ nativeID = KEYBOARD_ACCESSORY_ID }: { nativeID?: string }) {
  if (Platform.OS !== "ios") return null;
  return (
    <InputAccessoryView nativeID={nativeID}>
      <View style={styles.bar}>
        <Pressable onPress={() => Keyboard.dismiss()} hitSlop={8} accessibilityRole="button" accessibilityLabel="Dismiss keyboard">
          <Text style={styles.done}>Done</Text>
        </Pressable>
      </View>
    </InputAccessoryView>
  );
}

const styles = StyleSheet.create({
  bar: {
    flexDirection: "row",
    justifyContent: "flex-end",
    alignItems: "center",
    paddingHorizontal: theme.space.lg,
    paddingVertical: theme.space.sm,
    backgroundColor: theme.color.surfaceMuted,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: theme.color.border,
  },
  done: { fontFamily: theme.font.semibold, fontSize: 16, color: theme.color.brandRed },
});
