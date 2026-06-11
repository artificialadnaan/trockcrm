import React, { useState } from "react";
import { FlatList, Modal, Pressable, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { theme } from "../theme/theme";
import { useDebouncedValue } from "../hooks/useDebouncedValue";
import { useCaptureTargets } from "../query/hooks";
import type { FieldCaptureTarget } from "../api/types";
import { Badge, EmptyState, LoadingState, TextInput } from "./ui";

const TYPE_LABEL: Record<FieldCaptureTarget["type"], string> = {
  deal: "Deal",
  opportunity: "Opportunity",
  lead: "Lead",
};

/** Modal search over deals/opportunities/leads (debounced 200ms, like the web). */
export function TargetPicker({
  visible,
  onClose,
  onSelect,
}: {
  visible: boolean;
  onClose: () => void;
  onSelect: (target: FieldCaptureTarget) => void;
}) {
  const [search, setSearch] = useState("");
  const debounced = useDebouncedValue(search.trim(), 200);
  const { data, isFetching } = useCaptureTargets(debounced);
  const targets = data?.targets ?? [];

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose} presentationStyle="pageSheet">
      <SafeAreaView style={styles.container} edges={["top", "bottom"]}>
        <View style={styles.header}>
          <Text style={styles.title}>Choose a project</Text>
          <Pressable onPress={onClose} accessibilityLabel="Close" hitSlop={10}>
            <Text style={styles.close}>Done</Text>
          </Pressable>
        </View>
        <View style={styles.searchWrap}>
          <TextInput
            value={search}
            onChangeText={setSearch}
            placeholder="Search deals, opportunities, leads"
            autoCapitalize="none"
            autoFocus
          />
        </View>
        {debounced.length === 0 ? (
          <EmptyState title="Search to begin" subtitle="Type a project name or number." />
        ) : isFetching && targets.length === 0 ? (
          <LoadingState />
        ) : targets.length === 0 ? (
          <EmptyState title="No matches" subtitle={`Nothing found for "${debounced}".`} />
        ) : (
          <FlatList
            data={targets}
            keyExtractor={(t) => `${t.type}:${t.id}`}
            contentContainerStyle={{ padding: theme.space.lg, gap: theme.space.sm }}
            keyboardShouldPersistTaps="handled"
            renderItem={({ item }) => (
              <Pressable
                onPress={() => onSelect(item)}
                style={({ pressed }) => [styles.row, pressed && { opacity: 0.7 }]}
              >
                <View style={{ flex: 1, gap: 2 }}>
                  <Text style={styles.rowTitle} numberOfLines={1}>
                    {item.name}
                  </Text>
                  <Text style={styles.rowSub} numberOfLines={1}>
                    {[item.recordNumber, item.companyName, item.stageName].filter(Boolean).join(" · ") || "—"}
                  </Text>
                </View>
                <Badge label={TYPE_LABEL[item.type]} />
              </Pressable>
            )}
          />
        )}
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
  title: { fontFamily: theme.font.bold, fontSize: 18, color: theme.color.textPrimary },
  close: { fontFamily: theme.font.semibold, fontSize: 16, color: theme.color.brandRed },
  searchWrap: { paddingHorizontal: theme.space.lg, paddingBottom: theme.space.sm },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.space.md,
    backgroundColor: theme.color.surfaceCard,
    borderWidth: 1,
    borderColor: theme.color.border,
    borderRadius: theme.radius.md,
    padding: theme.space.md,
  },
  rowTitle: { fontFamily: theme.font.semibold, fontSize: 15, color: theme.color.textPrimary },
  rowSub: { fontFamily: theme.font.body, fontSize: 13, color: theme.color.textMuted },
});
