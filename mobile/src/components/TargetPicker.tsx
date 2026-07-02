import React, { useEffect, useState } from "react";
import { FlatList, Modal, Pressable, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { theme } from "../theme/theme";
import { useDebouncedValue } from "../hooks/useDebouncedValue";
import { getLiveGps } from "../capture/metadata";
import { useCaptureTargets, useNearbyCaptureTargets } from "../query/hooks";
import type { FieldCaptureTarget } from "../api/types";
import { Badge, EmptyState, LoadingState, TextInput } from "./ui";

const TYPE_LABEL: Record<FieldCaptureTarget["type"], string> = {
  deal: "Deal",
  opportunity: "Opportunity",
  lead: "Lead",
};

const NEARBY_LIMIT = 3;

type NearbyCoords = { latitude: number; longitude: number };

function formatDistance(miles: number | null | undefined) {
  if (miles === null || miles === undefined || !Number.isFinite(miles)) return null;
  if (miles < 0.1) return "<0.1 mi";
  return `${miles < 10 ? miles.toFixed(1) : Math.round(miles).toString()} mi`;
}

function targetSubtitle(target: FieldCaptureTarget) {
  return [formatDistance(target.distanceMiles), target.recordNumber, target.companyName, target.stageName]
    .filter(Boolean)
    .join(" · ") || "—";
}

/** Modal search over deals/opportunities/leads (debounced 200ms, like the web). */
export function TargetPicker({
  visible,
  onClose,
  onSelect,
  dealsOnly = false,
}: {
  visible: boolean;
  onClose: () => void;
  onSelect: (target: FieldCaptureTarget) => void;
  /** Scorecards attach to a deal (FK to deals) — restrict the picker so a lead/opportunity can't be chosen. */
  dealsOnly?: boolean;
}) {
  const [search, setSearch] = useState("");
  const [nearbyCoords, setNearbyCoords] = useState<NearbyCoords | null>(null);
  const [locationChecked, setLocationChecked] = useState(false);
  const debounced = useDebouncedValue(search.trim(), 200);
  const { data, isFetching } = useCaptureTargets(debounced);
  const nearbyQuery = useNearbyCaptureTargets(nearbyCoords, visible && debounced.length === 0, NEARBY_LIMIT);
  const onlyDeals = (items: FieldCaptureTarget[]) => (dealsOnly ? items.filter((t) => t.type === "deal") : items);
  const targets = onlyDeals(data?.targets ?? []);
  const nearbyTargets = onlyDeals(nearbyQuery.data?.targets ?? []);

  useEffect(() => {
    if (!visible) {
      setNearbyCoords(null);
      setLocationChecked(false);
      return;
    }
    if (debounced.length > 0) {
      setNearbyCoords(null);
      setLocationChecked(true);
      return;
    }
    let cancelled = false;
    setLocationChecked(false);
    void getLiveGps()
      .then((metadata) => {
        if (cancelled) return;
        if (metadata.latitude !== undefined && metadata.longitude !== undefined) {
          setNearbyCoords({ latitude: metadata.latitude, longitude: metadata.longitude });
        } else {
          setNearbyCoords(null);
        }
      })
      .finally(() => {
        if (!cancelled) setLocationChecked(true);
      });
    return () => {
      cancelled = true;
    };
  }, [visible, debounced]);

  function renderTargetList(items: FieldCaptureTarget[], header?: string) {
    return (
      <FlatList
        data={items}
        keyExtractor={(t) => `${t.type}:${t.id}`}
        contentContainerStyle={{ padding: theme.space.lg, gap: theme.space.sm }}
        keyboardShouldPersistTaps="handled"
        ListHeaderComponent={header ? <Text style={styles.listHeader}>{header}</Text> : null}
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
                {targetSubtitle(item)}
              </Text>
            </View>
            <Badge label={TYPE_LABEL[item.type]} />
          </Pressable>
        )}
      />
    );
  }

  function renderNearbyDefault() {
    if (nearbyTargets.length > 0) return renderTargetList(nearbyTargets, "Closest jobs");
    if (!locationChecked || nearbyQuery.isFetching) return <LoadingState label="Finding nearby jobs..." />;
    return <EmptyState title="Search to begin" subtitle="Type a project name or number." />;
  }

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
            placeholder={dealsOnly ? "Search projects" : "Search deals, opportunities, leads"}
            autoCapitalize="none"
          />
        </View>
        {debounced.length === 0 ? (
          renderNearbyDefault()
        ) : isFetching && targets.length === 0 ? (
          <LoadingState />
        ) : targets.length === 0 ? (
          <EmptyState title="No matches" subtitle={`Nothing found for "${debounced}".`} />
        ) : (
          renderTargetList(targets)
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
  listHeader: { fontFamily: theme.font.semibold, fontSize: 13, color: theme.color.textMuted, marginBottom: 2 },
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
