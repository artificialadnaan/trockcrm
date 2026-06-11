import React, { useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { theme } from "../theme/theme";
import { useDebouncedValue } from "../hooks/useDebouncedValue";
import { useProjectTags } from "../query/hooks";
import { TextInput } from "./ui";

/**
 * Tag input mirroring client-field PhotoTagInput: comma/return commits a tag,
 * case-insensitive dedupe, debounced (150ms) project autocomplete, tap-to-remove.
 */
export function PhotoTagInput({
  tags,
  onChange,
  dealId,
}: {
  tags: string[];
  onChange: (tags: string[]) => void;
  dealId?: string;
}) {
  const [draft, setDraft] = useState("");
  const debounced = useDebouncedValue(draft.trim(), 150);
  const { data } = useProjectTags(dealId, debounced);
  const suggestions = (data?.tags ?? []).filter(
    (s) => !tags.some((t) => t.toLowerCase() === s.toLowerCase()),
  );

  function addTag(raw: string) {
    const value = raw.trim();
    if (!value) return;
    if (!tags.some((t) => t.toLowerCase() === value.toLowerCase())) onChange([...tags, value]);
    setDraft("");
  }
  function onChangeText(text: string) {
    if (text.endsWith(",")) {
      addTag(text.slice(0, -1));
      return;
    }
    setDraft(text);
  }

  return (
    <View style={{ gap: theme.space.sm }}>
      {tags.length > 0 ? (
        <View style={styles.tagRow}>
          {tags.map((tag) => (
            <Pressable
              key={tag}
              onPress={() => onChange(tags.filter((t) => t !== tag))}
              style={styles.tagPill}
              accessibilityLabel={`Remove tag ${tag}`}
            >
              <Text style={styles.tagPillText}>{tag} ✕</Text>
            </Pressable>
          ))}
        </View>
      ) : null}
      <TextInput
        value={draft}
        onChangeText={onChangeText}
        onSubmitEditing={() => addTag(draft)}
        blurOnSubmit={false}
        autoCapitalize="none"
        placeholder="Add a tag — comma or return to commit"
      />
      {debounced.length > 0 && suggestions.length > 0 ? (
        <View style={styles.suggestions}>
          {suggestions.slice(0, 8).map((s) => (
            <Pressable key={s} onPress={() => addTag(s)} style={styles.suggestion}>
              <Text style={styles.suggestionText}>{s}</Text>
            </Pressable>
          ))}
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  tagRow: { flexDirection: "row", flexWrap: "wrap", gap: theme.space.sm },
  tagPill: {
    backgroundColor: theme.color.brandBlack,
    borderRadius: theme.radius.pill,
    paddingHorizontal: theme.space.md,
    paddingVertical: 6,
  },
  tagPillText: { color: theme.color.textInverse, fontFamily: theme.font.medium, fontSize: 13 },
  suggestions: { flexDirection: "row", flexWrap: "wrap", gap: theme.space.sm },
  suggestion: {
    borderWidth: 1,
    borderColor: theme.color.border,
    borderRadius: theme.radius.pill,
    paddingHorizontal: theme.space.md,
    paddingVertical: 6,
    backgroundColor: theme.color.surfaceMuted,
  },
  suggestionText: { color: theme.color.textPrimary, fontFamily: theme.font.body, fontSize: 13 },
});
