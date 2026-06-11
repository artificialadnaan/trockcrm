import React from "react";
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  TextInput as RNTextInput,
  type TextInputProps,
  View,
  type ViewProps,
} from "react-native";
import { theme } from "../theme/theme";

type ButtonVariant = "primary" | "ghost" | "danger";

export function Button({
  title,
  onPress,
  variant = "primary",
  loading = false,
  disabled = false,
  style,
  accessibilityLabel,
}: {
  title: string;
  onPress?: () => void;
  variant?: ButtonVariant;
  loading?: boolean;
  disabled?: boolean;
  style?: ViewProps["style"];
  accessibilityLabel?: string;
}) {
  const isDisabled = disabled || loading;
  const bg =
    variant === "primary" ? theme.color.brandRed : variant === "danger" ? theme.color.danger : "transparent";
  const fg = variant === "ghost" ? theme.color.textPrimary : theme.color.textInverse;
  return (
    <Pressable
      onPress={onPress}
      disabled={isDisabled}
      accessibilityRole="button"
      accessibilityState={{ disabled: isDisabled, busy: loading }}
      accessibilityLabel={accessibilityLabel ?? title}
      style={({ pressed }) => [
        styles.button,
        { backgroundColor: bg, opacity: isDisabled ? 0.55 : pressed ? 0.85 : 1 },
        variant === "ghost" && styles.buttonGhost,
        style,
      ]}
    >
      {loading ? (
        <ActivityIndicator color={fg} />
      ) : (
        <Text style={[styles.buttonText, { color: fg }]}>{title}</Text>
      )}
    </Pressable>
  );
}

export const TextInput = React.forwardRef<RNTextInput, TextInputProps>(function TextInput(props, ref) {
  return (
    <RNTextInput
      ref={ref}
      placeholderTextColor={theme.color.textMuted}
      style={[styles.input, props.style]}
      {...props}
    />
  );
});

export function Card({ style, children, ...rest }: ViewProps) {
  return (
    <View style={[styles.card, style]} {...rest}>
      {children}
    </View>
  );
}

export function Chip({
  label,
  selected = false,
  onPress,
  tone = "neutral",
}: {
  label: string;
  selected?: boolean;
  onPress?: () => void;
  tone?: "neutral" | "brand";
}) {
  const activeBg = tone === "brand" ? theme.color.brandRed : theme.color.brandBlack;
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityState={{ selected }}
      style={({ pressed }) => [
        styles.chip,
        selected ? { backgroundColor: activeBg, borderColor: activeBg } : null,
        pressed && { opacity: 0.8 },
      ]}
    >
      <Text style={[styles.chipText, selected && { color: theme.color.textInverse }]}>{label}</Text>
    </Pressable>
  );
}

export function Badge({ label, color = theme.color.surfaceMuted, textColor = theme.color.textMuted }: {
  label: string;
  color?: string;
  textColor?: string;
}) {
  return (
    <View style={[styles.badge, { backgroundColor: color }]}>
      <Text style={[styles.badgeText, { color: textColor }]} numberOfLines={1}>
        {label}
      </Text>
    </View>
  );
}

export function SectionLabel({ children }: { children: React.ReactNode }) {
  return <Text style={styles.sectionLabel}>{children}</Text>;
}

export function EmptyState({ title, subtitle }: { title: string; subtitle?: string }) {
  return (
    <View style={styles.empty}>
      <Text style={styles.emptyTitle}>{title}</Text>
      {subtitle ? <Text style={styles.emptySubtitle}>{subtitle}</Text> : null}
    </View>
  );
}

export function LoadingState({ label }: { label?: string }) {
  return (
    <View style={styles.loading}>
      <ActivityIndicator color={theme.color.brandRed} />
      {label ? <Text style={styles.loadingLabel}>{label}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  button: {
    minHeight: 50,
    borderRadius: theme.radius.md,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: theme.space.lg,
    flexDirection: "row",
  },
  buttonGhost: { borderWidth: 1, borderColor: theme.color.border },
  buttonText: { fontFamily: theme.font.semibold, fontSize: 16 },
  input: {
    minHeight: 48,
    borderWidth: 1,
    borderColor: theme.color.border,
    borderRadius: theme.radius.md,
    backgroundColor: theme.color.surfaceCard,
    paddingHorizontal: theme.space.md,
    fontSize: 16,
    fontFamily: theme.font.body,
    color: theme.color.textPrimary,
  },
  card: {
    backgroundColor: theme.color.surfaceCard,
    borderRadius: theme.radius.lg,
    borderWidth: 1,
    borderColor: theme.color.border,
    padding: theme.space.lg,
  },
  chip: {
    paddingHorizontal: theme.space.md,
    paddingVertical: theme.space.sm,
    borderRadius: theme.radius.pill,
    borderWidth: 1,
    borderColor: theme.color.border,
    backgroundColor: theme.color.surfaceCard,
  },
  chipText: { fontFamily: theme.font.medium, fontSize: 14, color: theme.color.textPrimary },
  badge: {
    paddingHorizontal: theme.space.sm,
    paddingVertical: 3,
    borderRadius: theme.radius.sm,
    alignSelf: "flex-start",
  },
  badgeText: { fontFamily: theme.font.medium, fontSize: 12 },
  sectionLabel: {
    fontFamily: theme.font.semibold,
    fontSize: 13,
    letterSpacing: 0.4,
    textTransform: "uppercase",
    color: theme.color.textMuted,
    marginBottom: theme.space.sm,
  },
  empty: { alignItems: "center", justifyContent: "center", paddingVertical: theme.space.xxl, gap: 6 },
  emptyTitle: { fontFamily: theme.font.semibold, fontSize: 16, color: theme.color.textPrimary },
  emptySubtitle: { fontFamily: theme.font.body, fontSize: 14, color: theme.color.textMuted, textAlign: "center" },
  loading: { alignItems: "center", justifyContent: "center", paddingVertical: theme.space.xxl, gap: 10 },
  loadingLabel: { fontFamily: theme.font.body, fontSize: 14, color: theme.color.textMuted },
});
