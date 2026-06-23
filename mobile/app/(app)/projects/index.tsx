import React, { useState } from "react";
import { FlatList, Pressable, RefreshControl, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useRouter } from "expo-router";
import { theme } from "../../../src/theme/theme";
import { useDebouncedValue } from "../../../src/hooks/useDebouncedValue";
import { useDeviceLocation } from "../../../src/hooks/useDeviceLocation";
import { useNearbyProjects, useProjects, useStarredProjects, useToggleStar } from "../../../src/query/hooks";
import { useAuth } from "../../../src/auth/AuthContext";
import { formatDistanceMiles, isProjectOffOffice, partitionProjectSections, projectNumberLabel, relativeDate, type FieldProject } from "../../../src/projects/field-projects";
import { Badge, EmptyState, LoadingState, TextInput } from "../../../src/components/ui";
import { Banner } from "../../../src/components/Banner";
import { ScreenHeader } from "../../../src/components/ScreenHeader";

export default function ProjectsScreen() {
  const router = useRouter();
  const { user, activeOfficeId } = useAuth();
  // Which office the single-office write endpoints target (active office, else the user's home office).
  const writableOfficeId = activeOfficeId ?? user?.tenantId;
  const [search, setSearch] = useState("");
  const debounced = useDebouncedValue(search.trim(), 250);
  const searching = debounced.length > 0;

  const { coords } = useDeviceLocation();
  const projectsQuery = useProjects(debounced);
  const starredQuery = useStarredProjects(!searching);
  // Nearby is hidden while searching (like Starred) and whenever there's no GPS fix (the hook returns
  // null coords, which disables the query) — so no permission nagging and no empty section.
  const nearbyQuery = useNearbyProjects(coords, !searching);
  const toggleStar = useToggleStar();

  const allProjects = projectsQuery.data?.projects ?? [];
  // Dedup precedence Nearby > Starred > All so nothing renders twice (pure + unit-tested).
  const { nearby, starred: visibleStarred, all: projects, hasSections } = partitionProjectSections(
    !searching ? nearbyQuery.data?.projects ?? [] : [],
    !searching ? starredQuery.data?.projects ?? [] : [],
    allProjects,
  );

  function openProject(project: FieldProject) {
    router.push({
      pathname: "/(app)/projects/[id]",
      params: {
        id: project.id,
        name: project.name,
        projectNumber: project.projectNumber ?? "",
        propertyAddress: project.propertyAddress ?? "",
        stage: project.stage,
        starred: project.starred ? "1" : "0",
        // Carry the owning office so the detail screen can gate write actions for off-office projects.
        officeId: project.officeId,
        officeSlug: project.officeSlug,
      },
    });
  }

  function onToggleStar(project: FieldProject) {
    toggleStar.mutate({ dealId: project.id, starred: project.starred });
  }

  const refreshing = projectsQuery.isRefetching || starredQuery.isRefetching || nearbyQuery.isRefetching;
  function onRefresh() {
    void projectsQuery.refetch();
    if (!searching) {
      void starredQuery.refetch();
      // refetch() runs the queryFn even though the query is disabled without coords — and that queryFn
      // dereferences coords — so only refetch Nearby when we actually have a fix.
      if (coords) void nearbyQuery.refetch();
    }
  }

  return (
    <SafeAreaView style={styles.safe} edges={["top"]}>
      <ScreenHeader />

      {/* Search is pinned above the list (not inside its scrolling header) so it
          stays reachable as the rep pages down (#4). clearButtonMode adds a one-tap
          X to clear the query (#5). */}
      <View style={styles.searchBar}>
        <TextInput
          value={search}
          onChangeText={setSearch}
          placeholder="Search by name, deal #, or address"
          autoCapitalize="none"
          autoCorrect={false}
          clearButtonMode="while-editing"
          returnKeyType="search"
        />
      </View>

      <FlatList
        data={projects}
        keyExtractor={(p) => p.id}
        contentContainerStyle={styles.list}
        keyboardShouldPersistTaps="handled"
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={theme.color.brandRed} />}
        ListHeaderComponent={
          projectsQuery.isError || hasSections ? (
            <View style={{ gap: theme.space.md }}>
              {projectsQuery.isError ? (
                <Banner message="Couldn't load projects. Pull to refresh." />
              ) : null}
              {/* Nearby sits above Starred — it's the "right now" context. Each row shows its distance. */}
              {nearby.length > 0 ? (
                <View style={{ gap: theme.space.sm }}>
                  <Text style={styles.sectionTitle}>Nearby</Text>
                  {nearby.map((project) => (
                    <ProjectRow
                      key={`nearby-${project.id}`}
                      project={project}
                      writableOfficeId={writableOfficeId}
                      distanceLabel={formatDistanceMiles(project.distanceMiles)}
                      onPress={() => openProject(project)}
                      onToggleStar={() => onToggleStar(project)}
                    />
                  ))}
                </View>
              ) : null}
              {visibleStarred.length > 0 ? (
                <View style={{ gap: theme.space.sm }}>
                  <Text style={styles.sectionTitle}>Starred</Text>
                  {visibleStarred.map((project) => (
                    <ProjectRow
                      key={`starred-${project.id}`}
                      project={project}
                      writableOfficeId={writableOfficeId}
                      onPress={() => openProject(project)}
                      onToggleStar={() => onToggleStar(project)}
                    />
                  ))}
                </View>
              ) : null}
              {/* Label the main list once any section renders above it, so "All projects" isn't ambiguous. */}
              {hasSections && projects.length > 0 ? (
                <Text style={styles.sectionTitle}>All projects</Text>
              ) : null}
            </View>
          ) : null
        }
        renderItem={({ item }) => (
          <ProjectRow project={item} writableOfficeId={writableOfficeId} onPress={() => openProject(item)} onToggleStar={() => onToggleStar(item)} />
        )}
        ListEmptyComponent={
          projectsQuery.isLoading ? (
            <LoadingState label="Loading projects…" />
          ) : // On error the header Banner already explains it + offers pull-to-refresh — don't
          // also claim "No projects yet" (those two messages contradict each other) (#8).
          projectsQuery.isError ? null : hasSections ? null : (
            <EmptyState
              title={searching ? "No matches" : "No projects yet"}
              subtitle={searching ? `Nothing found for "${debounced}".` : "Active projects will appear here."}
            />
          )
        }
      />
    </SafeAreaView>
  );
}

function ProjectRow({
  project,
  writableOfficeId,
  distanceLabel,
  onPress,
  onToggleStar,
}: {
  project: FieldProject;
  writableOfficeId: string | null | undefined;
  /** Distance pill shown only on Nearby rows (e.g. "2.3 mi"); omitted/undefined everywhere else. */
  distanceLabel?: string | null;
  onPress: () => void;
  onToggleStar: () => void;
}) {
  // Cross-office projects are view-only until cross-office writes ship — suppress the star (its
  // single-office write would 404) and show a view-only badge so the row is clearly read-only.
  const offOffice = isProjectOffOffice(project, writableOfficeId);
  // The star is a SIBLING of the row's tappable area (not nested inside it), so
  // tapping the star toggles only — it can never bubble into opening the project.
  return (
    <View style={styles.row}>
      <Pressable
        onPress={onPress}
        style={({ pressed }) => [{ flex: 1, gap: 4 }, pressed && { opacity: 0.6 }]}
        accessibilityRole="button"
        accessibilityLabel={`Open ${project.name}, ${project.projectNumber ? `project number ${project.projectNumber}` : "project pending"}, ${project.stage}`}
      >
        {/* Full-width name on its own line — the stage badge no longer competes for width (#1). */}
        <Text style={styles.rowName} numberOfLines={1}>
          {project.name}
        </Text>
        {/* Project # is promoted to a prominent, non-truncating element so rows that differ
            only by project # stay distinguishable; the stage badge wraps beside it (#2). Shows the
            canonical DFW/ATL number (never the HubSpot id); a muted "Project pending" when none. */}
        <View style={styles.rowBadges}>
          <Text style={[styles.rowDeal, !project.projectNumber && styles.rowDealPending]}>
            {projectNumberLabel(project.projectNumber)}
          </Text>
          <Badge label={project.stage} />
          {distanceLabel ? <Text style={styles.rowDistance}>{distanceLabel}</Text> : null}
        </View>
        {/* Always render the address line (muted fallback) so cards keep a consistent height (#3). */}
        <Text style={[styles.rowAddress, !project.propertyAddress && styles.rowAddressMissing]} numberOfLines={1}>
          {project.propertyAddress || "No address on file"}
        </Text>
        <Text style={styles.rowMeta}>
          {project.photoCount} photo{project.photoCount === 1 ? "" : "s"} · {relativeDate(project.lastActivityAt)}
        </Text>
      </Pressable>
      {offOffice ? (
        <View style={styles.starButton} accessibilityLabel={`Managed by the ${project.officeSlug} office — view only`}>
          <Badge label={`${project.officeSlug} · view-only`} />
        </View>
      ) : (
        <Pressable
          onPress={onToggleStar}
          hitSlop={12}
          style={styles.starButton}
          accessibilityRole="button"
          accessibilityLabel={project.starred ? `Unstar ${project.name}` : `Star ${project.name}`}
        >
          <Text style={[styles.star, project.starred && { color: theme.color.brandRed }]}>
            {project.starred ? "★" : "☆"}
          </Text>
        </Pressable>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: theme.color.surfaceApp },
  searchBar: { paddingHorizontal: theme.space.lg, paddingTop: theme.space.md, paddingBottom: theme.space.sm },
  list: { paddingHorizontal: theme.space.lg, paddingBottom: theme.space.lg, paddingTop: theme.space.xs, gap: theme.space.sm },
  sectionTitle: { fontFamily: theme.font.semibold, fontSize: 13, color: theme.color.textMuted, textTransform: "uppercase", letterSpacing: 0.4 },
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
  rowName: { fontFamily: theme.font.semibold, fontSize: 15, color: theme.color.textPrimary },
  rowBadges: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: theme.space.sm },
  rowDeal: { fontFamily: theme.font.semibold, fontSize: 13, color: theme.color.textPrimary },
  rowDealPending: { color: theme.color.textMuted, fontStyle: "italic" },
  rowDistance: { fontFamily: theme.font.semibold, fontSize: 12, color: theme.color.brandRed },
  rowAddress: { fontFamily: theme.font.body, fontSize: 13, color: theme.color.textMuted },
  rowAddressMissing: { fontStyle: "italic", color: theme.color.textMuted, opacity: 0.7 },
  rowMeta: { fontFamily: theme.font.body, fontSize: 12, color: theme.color.textMuted },
  starButton: { paddingHorizontal: theme.space.sm, paddingVertical: theme.space.sm },
  star: { fontSize: 26, color: theme.color.textMuted },
});
