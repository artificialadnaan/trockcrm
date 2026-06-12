import React, { useState } from "react";
import { FlatList, Pressable, RefreshControl, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useRouter } from "expo-router";
import { theme } from "../../../src/theme/theme";
import { useDebouncedValue } from "../../../src/hooks/useDebouncedValue";
import { useProjects, useStarredProjects, useToggleStar } from "../../../src/query/hooks";
import { useAuth } from "../../../src/auth/AuthContext";
import { isProjectOffOffice, relativeDate, type FieldProject } from "../../../src/projects/field-projects";
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

  const projectsQuery = useProjects(debounced);
  const starredQuery = useStarredProjects(!searching);
  const toggleStar = useToggleStar();

  const allProjects = projectsQuery.data?.projects ?? [];
  const starred = !searching ? starredQuery.data?.projects ?? [] : [];
  // Don't list a starred project twice — drop them from the main list when the
  // Starred section is shown (mirrors the field web app).
  const starredIds = new Set(starred.map((p) => p.id));
  const projects = starred.length > 0 ? allProjects.filter((p) => !starredIds.has(p.id)) : allProjects;

  function openProject(project: FieldProject) {
    router.push({
      pathname: "/(app)/projects/[id]",
      params: {
        id: project.id,
        name: project.name,
        dealNumber: project.dealNumber,
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

  const refreshing = projectsQuery.isRefetching || starredQuery.isRefetching;
  function onRefresh() {
    void projectsQuery.refetch();
    if (!searching) void starredQuery.refetch();
  }

  return (
    <SafeAreaView style={styles.safe} edges={["top"]}>
      <ScreenHeader />

      <FlatList
        data={projects}
        keyExtractor={(p) => p.id}
        contentContainerStyle={styles.list}
        keyboardShouldPersistTaps="handled"
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={theme.color.brandRed} />}
        ListHeaderComponent={
          <View style={{ gap: theme.space.md }}>
            <TextInput
              value={search}
              onChangeText={setSearch}
              placeholder="Search by name, deal #, or address"
              autoCapitalize="none"
              autoCorrect={false}
            />
            {projectsQuery.isError ? (
              <Banner message="Couldn't load projects. Pull to refresh." />
            ) : null}
            {starred.length > 0 ? (
              <View style={{ gap: theme.space.sm }}>
                <Text style={styles.sectionTitle}>Starred</Text>
                {starred.map((project) => (
                  <ProjectRow
                    key={`starred-${project.id}`}
                    project={project}
                    writableOfficeId={writableOfficeId}
                    onPress={() => openProject(project)}
                    onToggleStar={() => onToggleStar(project)}
                  />
                ))}
                <Text style={[styles.sectionTitle, { marginTop: theme.space.sm }]}>All projects</Text>
              </View>
            ) : null}
          </View>
        }
        renderItem={({ item }) => (
          <ProjectRow project={item} writableOfficeId={writableOfficeId} onPress={() => openProject(item)} onToggleStar={() => onToggleStar(item)} />
        )}
        ListEmptyComponent={
          projectsQuery.isLoading ? (
            <LoadingState label="Loading projects…" />
          ) : starred.length > 0 ? null : (
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
  onPress,
  onToggleStar,
}: {
  project: FieldProject;
  writableOfficeId: string | null | undefined;
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
        accessibilityLabel={`Open ${project.name}`}
      >
        <View style={styles.rowTop}>
          <Text style={styles.rowName} numberOfLines={1}>
            {project.name}
          </Text>
          <Badge label={project.stage} />
        </View>
        {project.propertyAddress ? (
          <Text style={styles.rowAddress} numberOfLines={1}>
            {project.propertyAddress}
          </Text>
        ) : null}
        <Text style={styles.rowMeta}>
          #{project.dealNumber} · {project.photoCount} photo{project.photoCount === 1 ? "" : "s"} ·{" "}
          {relativeDate(project.lastActivityAt)}
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
          accessibilityLabel={project.starred ? "Unstar" : "Star"}
        >
          <Text style={[styles.star, project.starred && { color: theme.color.warning }]}>
            {project.starred ? "★" : "☆"}
          </Text>
        </Pressable>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: theme.color.surfaceApp },
  list: { padding: theme.space.lg, gap: theme.space.sm },
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
  rowTop: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: theme.space.sm },
  rowName: { flex: 1, fontFamily: theme.font.semibold, fontSize: 15, color: theme.color.textPrimary },
  rowAddress: { fontFamily: theme.font.body, fontSize: 13, color: theme.color.textMuted },
  rowMeta: { fontFamily: theme.font.body, fontSize: 12, color: theme.color.textMuted },
  starButton: { paddingLeft: theme.space.sm, paddingVertical: theme.space.xs },
  star: { fontSize: 24, color: theme.color.textMuted },
});
