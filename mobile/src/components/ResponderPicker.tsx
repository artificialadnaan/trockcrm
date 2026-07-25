// A name-entry field with a searchable dropdown backed by the CRM field-responder roster. PURELY
// presentational (roster + error are passed in, not fetched) so it unit-tests without an AuthProvider.
//
// The bound `value` is the draft's superintendentName/pmName string. `onChange` always receives the plain
// name, and ALSO the roster row when — and only when — the name came from PICKING that row; typing hands back
// `null`. That second argument is what lets the draft record WHICH roster person was chosen (their id rides to
// the server and becomes the corrective-action recipient for the card), while keeping a typed name a typed
// name: a free-text entry that happens to spell a roster member is not a pick and must not silently address
// them. The dropdown is a convenience over free-text, never a gate: typing always works (offline / off-roster
// / a name the CRM doesn't know), and when there's no roster (empty list or a load `error`) it renders just
// the TextInput — so a null responder is a first-class outcome, not an error path.

import React, { useRef, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import type { TextInput as RNTextInput } from "react-native";
import { TextInput } from "./ui";
import { theme } from "../theme/theme";
import type { FieldResponderOption, FieldResponderRole } from "../api/types";

const MAX_SUGGESTIONS = 6;

/**
 * Roster rows to suggest for the current input. Filters to this `role`, matches `query` case-insensitively as
 * a substring of the name, and EXCLUDES an exact (case-insensitive) match of the current value so a picked
 * name doesn't keep suggesting itself. A blank query shows the role's roster (capped) so a focused-but-empty
 * field still offers the list. Pure so it's trivially testable.
 */
export function matchResponders(
  responders: FieldResponderOption[],
  role: FieldResponderRole,
  query: string,
  opts?: { hasPick?: boolean },
): FieldResponderOption[] {
  const q = query.trim().toLowerCase();
  return responders
    .filter((r) => r.role === role)
    .filter((r) => {
      const name = r.name.toLowerCase();
      // Hide the row whose name is already exactly entered — but ONLY when that name came from picking it.
      // If the text merely spells a roster member with no pick recorded (the user typed it, or edited a picked
      // name and undid the edit, which clears the pick), the row must stay offered: it is the only way to
      // record the pick, and a hidden row would leave the card displaying that person's name while quietly
      // routing its corrective action to the deal team instead.
      if (name === q && opts?.hasPick) return false;
      return q.length === 0 || name.includes(q);
    })
    .slice(0, MAX_SUGGESTIONS);
}

const ROLE_LABEL: Record<FieldResponderRole, string> = {
  superintendent: "Superintendent",
  project_manager: "Project manager",
};

export function ResponderPicker({
  value,
  onChange,
  role,
  responders,
  error,
  responderId,
}: {
  value: string;
  /**
   * `responder` is the roster row ONLY when the name came from pressing that row; every free-text keystroke
   * passes `null`. Callers must treat `null` as "clear the recorded pick" — never as "keep whatever was
   * picked before" — or an id can outlive the name it belonged to.
   */
  onChange: (name: string, responder: FieldResponderOption | null) => void;
  role: FieldResponderRole;
  responders: FieldResponderOption[];
  error?: string | null;
  /** The pick currently recorded for this field, if any — drives whether the exact-name row is still offered. */
  responderId?: string | null;
}) {
  const [focused, setFocused] = useState(false);
  const inputRef = useRef<RNTextInput>(null);

  // No roster to suggest from (failed load or empty office roster) → pure free-text field. Typing still works.
  const hasRoster = !error && responders.length > 0;
  const suggestions =
    hasRoster && focused ? matchResponders(responders, role, value, { hasPick: !!responderId }) : [];
  const showSuggestions = suggestions.length > 0;

  // Report the WHOLE roster row, not just its name: the id travels with the exact name it belongs to, in one
  // call, so no caller can end up holding an id for a different person's name.
  const pick = (responder: FieldResponderOption) => {
    onChange(responder.name, responder);
    setFocused(false);
    // Blur the NATIVE input too, not just our `focused` flag. Both scorecard forms use
    // keyboardShouldPersistTaps="handled", so the input stays focused after a suggestion press; without an
    // explicit blur, tapping the (already-focused) input to edit emits no onFocus and the suggestions would stay
    // hidden until the user focuses something else. Blurring dismisses the keyboard so the next tap re-opens them.
    inputRef.current?.blur();
  };

  return (
    <View>
      <TextInput
        ref={inputRef}
        value={value}
        // Typing is never a pick — always clear the recorded responder, even if the typed text happens to
        // spell a roster member exactly. Name-matching is what made the earlier attempt at this feature
        // able to email someone the user never chose.
        onChangeText={(text) => onChange(text, null)}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        placeholder={`Name (${ROLE_LABEL[role].toLowerCase()})`}
        autoCapitalize="words"
        accessibilityLabel={`${ROLE_LABEL[role]} name`}
      />
      {showSuggestions ? (
        <View style={styles.menu}>
          {suggestions.map((r) => (
            <Pressable
              key={r.id}
              // onPress fires after onBlur; keep the value change here so the pick wins over the blur.
              onPress={() => pick(r)}
              accessibilityRole="button"
              // Include the email: only ACTIVE emails are unique on the roster, so two people can share a
              // name, and pressing one vs the other now routes this card's corrective action to a different
              // address. The email is already on screen for sighted users — without it here a screen-reader
              // user has two identical "Select James Helms" buttons and no way to tell which is which.
              accessibilityLabel={`Select ${r.name}, ${r.email}`}
              style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
            >
              <Text style={styles.rowName} numberOfLines={1}>
                {r.name}
              </Text>
              {r.email ? (
                <Text style={styles.rowMeta} numberOfLines={1}>
                  {r.email}
                </Text>
              ) : null}
            </Pressable>
          ))}
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  menu: {
    marginTop: theme.space.xs,
    borderWidth: 1,
    borderColor: theme.color.border,
    borderRadius: theme.radius.md,
    backgroundColor: theme.color.surfaceCard,
    overflow: "hidden",
  },
  row: {
    paddingHorizontal: theme.space.md,
    paddingVertical: theme.space.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: theme.color.border,
  },
  rowPressed: { backgroundColor: theme.color.surfaceMuted },
  rowName: { fontFamily: theme.font.medium, fontSize: 15, color: theme.color.textPrimary },
  rowMeta: { fontFamily: theme.font.body, fontSize: 12, color: theme.color.textMuted, marginTop: 2 },
});
