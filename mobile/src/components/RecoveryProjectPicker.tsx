/**
 * The project picker for a walk that is being RECOVERED — an orphaned recording on this phone that
 * never reached the upload manifest, being named by the estimator who made it (see Profile's
 * RecoverableWalksCard).
 *
 * It exists as its own surface, rather than a flag on TargetPicker, because it asks the server a
 * DIFFERENT question — and that difference must not be one boolean away from ordinary browsing.
 *
 * The capture-target search takes one `dealsOnly` flag that conflates two things: "deals, not leads"
 * and "browsable projects only" — active pipeline or Won-family, never Lost/terminal (see
 * files/service.ts, which mirrors field/projects-service.activeProjectWhere). That pairing is right
 * for the scorecard picker, whose server gate refuses a terminal deal outright. It is wrong here,
 * because the glasses-walkthrough upload routes were deliberately widened (commit fde1d0a04) to
 * accept ANY active deal: a walk drains for hours or days, a deal can go to Lost inside that window,
 * and evidence of a visit that really happened must still be filable afterwards. A walk orphaned
 * before it ever got a manifest entry is that case at its worst — the recording is unrepeatable, and
 * for a lost bid the record is exactly the one most likely to be re-examined.
 *
 * So this picker asks the unfiltered question (`dealsOnly` OFF), where the server applies nothing to
 * deals but `is_active = true` — precisely the set `assertAccessibleFieldCaptureTarget` accepts —
 * and re-narrows to deals HERE. Two consequences, both deliberate:
 *
 *   - The client-side deal filter is LOAD-BEARING here, not the belt-and-suspenders one TargetPicker
 *     keeps: the unfiltered answer really does contain leads and opportunities, and both walkthrough
 *     endpoints are addressed by dealId, so filing a walk to a lead could only ever 404 forever.
 *   - Both questions are asked and the answers MERGED, not swapped. Without `dealsOnly` the server
 *     caps leads and opportunities before deals (per-type in one office, and in ONE global slice
 *     ordered lead → opportunity → deal when cross-office reads are on), so the unfiltered answer
 *     alone can come back with fewer deals — or none — for a search the ordinary picker answers
 *     fine. Merging keeps this list a strict superset of what the estimator would otherwise be
 *     offered: recovery WIDENS the choice, it never narrows it.
 *
 * The "closest jobs" default is kept, unchanged, from the shared picker. The commonest orphan by
 * far is an app kill DURING a walk, noticed immediately, on the site — and there the nearest jobs
 * are the fastest correct answer. That list stays browsing-scoped (the nearby endpoint carries
 * `activeProjectWhere()` server-side), so a job that has gone to Lost will never appear in it; the
 * widening lives in the SEARCH, which is what the hint under the search box points at.
 */
import { useEffect, useState } from "react";
import { FlatList, Modal, Pressable, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { theme } from "../theme/theme";
import { useDebouncedValue } from "../hooks/useDebouncedValue";
import { getLiveGps } from "../capture/metadata";
import { useCaptureTargets, useNearbyCaptureTargets } from "../query/hooks";
import type { FieldCaptureTarget } from "../api/types";
import { EmptyState, LoadingState, TextInput } from "./ui";

const NEARBY_LIMIT = 3;

type NearbyCoords = { latitude: number; longitude: number };

/**
 * Every DEAL either answer knows about, browsable ones first, each listed once.
 *
 * Order matters and is not alphabetical or re-ranked: the browsable answer is the ordinary picker's
 * own relevance order, so the projects an estimator would normally be offered stay where they
 * normally are, and the ones the browsing rule hides are appended rather than interleaved.
 */
function mergeRecoveryDeals(
  browsable: readonly FieldCaptureTarget[],
  everyActive: readonly FieldCaptureTarget[],
): FieldCaptureTarget[] {
  const seen = new Set<string>();
  const deals: FieldCaptureTarget[] = [];
  for (const target of [...browsable, ...everyActive]) {
    if (target.type !== "deal") continue; // leads/opportunities are not addressable by these routes
    if (seen.has(target.id)) continue; // the same job from both answers is still one job
    seen.add(target.id);
    deals.push(target);
  }
  return deals;
}

function formatDistance(miles: number | null | undefined): string | null {
  if (miles === null || miles === undefined || !Number.isFinite(miles)) return null;
  if (miles < 0.1) return "<0.1 mi";
  return `${miles < 10 ? miles.toFixed(1) : Math.round(miles).toString()} mi`;
}

function dealSubtitle(target: FieldCaptureTarget): string {
  // The stage is part of the choice here, not decoration: it is how "Bid Lost" — the reason this
  // project is missing from every other picker in the app — is stated rather than hidden.
  return (
    [formatDistance(target.distanceMiles), target.recordNumber, target.companyName, target.stageName]
      .filter(Boolean)
      .join(" · ") || "—"
  );
}

export function RecoveryProjectPicker({
  visible,
  onClose,
  onSelect,
}: {
  visible: boolean;
  onClose: () => void;
  onSelect: (target: FieldCaptureTarget) => void;
}) {
  const [search, setSearch] = useState("");
  const [nearbyCoords, setNearbyCoords] = useState<NearbyCoords | null>(null);
  const [locationChecked, setLocationChecked] = useState(false);
  const debounced = useDebouncedValue(search.trim(), 200);
  // Both hooks are unconditional (rules of hooks) and both no-op until something is typed —
  // useCaptureTargets is `enabled` only for a non-empty search — so an open picker costs nothing
  // until the estimator actually asks a question.
  const browsable = useCaptureTargets(debounced, true);
  const everyActiveDeal = useCaptureTargets(debounced, false);
  const targets = mergeRecoveryDeals(
    browsable.data?.targets ?? [],
    everyActiveDeal.data?.targets ?? [],
  );
  // Either query still running counts as fetching: showing "No matches" while the widened half is
  // still in flight would tell the estimator their job does not exist a moment before it appears.
  const isFetching = browsable.isFetching || everyActiveDeal.isFetching;
  const nearbyQuery = useNearbyCaptureTargets(nearbyCoords, visible && debounced.length === 0, NEARBY_LIMIT);
  // Deals only, same rule as the search results and for the same reason — the nearby endpoint is
  // already deal-only server-side, so this is the belt-and-suspenders half.
  const nearbyDeals = (nearbyQuery.data?.targets ?? []).filter((target) => target.type === "deal");

  // Same GPS lifecycle as the shared picker: read a live fix while the picker is open and nothing is
  // typed, drop it the moment either stops being true, and never let a late fix land on a closed
  // picker.
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

  function renderNearbyDefault() {
    if (nearbyDeals.length > 0) return renderDealList(nearbyDeals, "Closest jobs");
    if (!locationChecked || nearbyQuery.isFetching) return <LoadingState label="Finding nearby jobs..." />;
    // The nearby list is browsing-scoped, so a walk whose job has gone to Lost can only be found by
    // searching — which is what this says, rather than the shared picker's bare "Search to begin".
    return (
      <EmptyState
        title="Search for the project you walked"
        subtitle="Type a project name, number or address."
      />
    );
  }

  function renderDealList(items: FieldCaptureTarget[], header?: string) {
    return (
      <FlatList
        data={items}
        keyExtractor={(target) => target.id}
        contentContainerStyle={styles.list}
        keyboardShouldPersistTaps="handled"
        ListHeaderComponent={header ? <Text style={styles.listHeader}>{header}</Text> : null}
        renderItem={({ item }) => (
          <Pressable
            onPress={() => onSelect(item)}
            accessibilityRole="button"
            accessibilityLabel={`File this walk to ${item.name} — ${dealSubtitle(item)}`}
            style={({ pressed }) => [styles.row, pressed && { opacity: 0.7 }]}
          >
            <View style={styles.rowText}>
              <Text style={styles.rowTitle} numberOfLines={1}>
                {item.name}
              </Text>
              <Text style={styles.rowSub} numberOfLines={1}>
                {dealSubtitle(item)}
              </Text>
            </View>
          </Pressable>
        )}
      />
    );
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
            placeholder="Search projects"
            autoCapitalize="none"
          />
          {/* Said out loud, because it is the difference between this picker and every other one in
              the app: the walk was recorded before the job's stage was, and a bid that has since
              been lost is still a site visit that happened. */}
          <Text style={styles.hint}>
            Closed and lost projects are listed too — this walk can still be filed to one.
          </Text>
        </View>
        {debounced.length === 0 ? (
          renderNearbyDefault()
        ) : isFetching && targets.length === 0 ? (
          <LoadingState />
        ) : targets.length === 0 ? (
          <EmptyState title="No matches" subtitle={`Nothing found for "${debounced}".`} />
        ) : (
          renderDealList(targets)
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
  searchWrap: { paddingHorizontal: theme.space.lg, paddingBottom: theme.space.sm, gap: theme.space.sm },
  hint: { fontFamily: theme.font.body, fontSize: 12, color: theme.color.textMuted, lineHeight: 16 },
  listHeader: { fontFamily: theme.font.semibold, fontSize: 13, color: theme.color.textMuted, marginBottom: 2 },
  list: { padding: theme.space.lg, gap: theme.space.sm },
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
  rowText: { flex: 1, gap: 2 },
  rowTitle: { fontFamily: theme.font.semibold, fontSize: 15, color: theme.color.textPrimary },
  rowSub: { fontFamily: theme.font.body, fontSize: 13, color: theme.color.textMuted },
});
