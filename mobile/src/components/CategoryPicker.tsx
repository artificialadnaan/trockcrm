import React from "react";
import { ScrollView } from "react-native";
import { PHOTO_CATEGORIES } from "../projects/field-projects";
import { theme } from "../theme/theme";
import { Chip } from "./ui";

/** Horizontal chip row for the 6 phase photo categories (tap-again to clear). */
export function CategoryPicker({
  value,
  onChange,
}: {
  value: string | null;
  onChange: (value: string | null) => void;
}) {
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={{ gap: theme.space.sm, paddingVertical: theme.space.xs }}
    >
      {PHOTO_CATEGORIES.map((category) => (
        <Chip
          key={category.value}
          label={category.label}
          tone="brand"
          selected={value === category.value}
          onPress={() => onChange(value === category.value ? null : category.value)}
        />
      ))}
    </ScrollView>
  );
}
