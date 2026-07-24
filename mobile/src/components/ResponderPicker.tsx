// A name-entry field with a searchable dropdown backed by the CRM field-responder roster. PURELY
// presentational (roster + error are passed in, not fetched) so it unit-tests without an AuthProvider.
//
// Storage stays NAME-ONLY: the bound `value` is the draft's superintendentName/pmName string and `onChange`
// receives the plain name — whether the user picks a roster row OR types a custom name. The dropdown is a
// convenience over free-text, never a gate: typing always works (offline / off-roster / a name the CRM
// doesn't know), and when there's no roster (empty list or a load `error`) it renders just the TextInput.

import React, { useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
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
): FieldResponderOption[] {
  const q = query.trim().toLowerCase();
  return responders
    .filter((r) => r.role === role)
    .filter((r) => {
      const name = r.name.toLowerCase();
      if (name === q) return false; // already exactly entered — nothing to suggest
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
}: {
  value: string;
  onChange: (name: string) => void;
  role: FieldResponderRole;
  responders: FieldResponderOption[];
  error?: string | null;
}) {
  const [focused, setFocused] = useState(false);

  // No roster to suggest from (failed load or empty office roster) → pure free-text field. Typing still works.
  const hasRoster = !error && responders.length > 0;
  const suggestions = hasRoster && focused ? matchResponders(responders, role, value) : [];
  const showSuggestions = suggestions.length > 0;

  const pick = (name: string) => {
    onChange(name);
    // Dismiss the list after a pick — behaves like a blur without needing the native keyboard to dismiss.
    setFocused(false);
  };

  return (
    <View>
      <TextInput
        value={value}
        onChangeText={onChange}
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
              onPress={() => pick(r.name)}
              accessibilityRole="button"
              accessibilityLabel={`Select ${r.name}`}
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
