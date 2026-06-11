import React, { useState } from "react";
import { FlatList, Pressable, RefreshControl, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useRouter } from "expo-router";
import { theme } from "../../../src/theme/theme";
import { useDebouncedValue } from "../../../src/hooks/useDebouncedValue";
import { useProjects, useStarredProjects, useToggleStar } from "../../../src/query/hooks";
import { relativeDate, type FieldProject } from "../../../src/projects/field-projects";
import { Badge, EmptyState, LoadingState, TextInput } from "../../../src/components/ui";
import { Banner } from "../../../src/components/Banner";
import { BrandLogo } from "../../../src/components/BrandLogo";

export default function ProjectsScreen() {
  const router = useRouter();
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
      <View style={styles.header}>
        <BrandLogo size={36} />
      </View>

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
          <ProjectRow project={item} onPress={() => openProject(item)} onToggleStar={() => onToggleStar(item)} />
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
  onPress,
  onToggleStar,
}: {
  project: FieldProject;
  onPress: () => void;
  onToggleStar: () => void;
}) {
  return (
    <Pressable onPress={onPress} style={({ pressed }) => [styles.row, pressed && { opacity: 0.7 }]}>
      <View style={{ flex: 1, gap: 4 }}>
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
      </View>
      <Pressable onPress={onToggleStar} hitSlop={12} accessibilityLabel={project.starred ? "Unstar" : "Star"}>
        <Text style={[styles.star, project.starred && { color: theme.color.warning }]}>
          {project.starred ? "★" : "☆"}
        </Text>
      </Pressable>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: theme.color.surfaceApp },
  header: {
    paddingHorizontal: theme.space.lg,
    paddingVertical: theme.space.sm,
    borderBottomWidth: 1,
    borderBottomColor: theme.color.border,
    backgroundColor: theme.color.surfaceCard,
  },
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
  star: { fontSize: 24, color: theme.color.textMuted },
});
