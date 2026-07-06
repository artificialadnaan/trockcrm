import React from "react";
import { Image, Pressable, StyleSheet, Text, View, useWindowDimensions } from "react-native";
import { theme } from "../theme/theme";
import { Button, SectionLabel } from "./ui";
import { RatingBadge } from "./RatingBadge";
import type { FieldScorecardDetail, FieldScorecardPhotoView } from "../api/types";
import {
  deficiencyLabel,
  formatShortDate,
  scorecardPhotoSections,
  scorecardSectionRows,
  SCORECARD_TOTAL_POINTS,
} from "../scorecards/detail-view";

const GRID_GAP = 4;
const GRID_COLUMNS = 3;

/**
 * Native render of one submitted scorecard. Presentational only — the route screen (view/[id].tsx)
 * fetches the data and owns download/photo actions. The web ScorecardDetailView is React-DOM and not
 * reusable in RN, so this is a purpose-built mirror.
 *
 * Evidence photos are opened by the route screen via Linking (system browser) for v1 — see Design
 * decision #5. Null `url` (a real server output: the detail presign is best-effort, .catch(() => null))
 * renders a placeholder tile rather than a broken <Image>.
 */
export function ScorecardDetailView({
  scorecard,
  onDownloadPdf,
  downloadingPdf,
  onOpenPhoto,
}: {
  scorecard: FieldScorecardDetail;
  onDownloadPdf: () => void;
  downloadingPdf: boolean;
  onOpenPhoto?: (photo: FieldScorecardPhotoView) => void;
}) {
  const { width } = useWindowDimensions();
  const thumb = Math.floor((width - theme.space.lg * 2 - GRID_GAP * (GRID_COLUMNS - 1)) / GRID_COLUMNS);

  const sections = scorecardSectionRows(scorecard.items);
  const photoSections = scorecardPhotoSections(scorecard.photos);
  const deficiencies = scorecard.criticalDeficiencies;
  const actionItems = scorecard.actionItems;

  return (
    <View style={{ gap: theme.space.lg }}>
      {/* Score summary */}
      <View style={styles.summary}>
        <Text style={styles.score}>
          {scorecard.totalScore}
          <Text style={styles.scoreMax}> / {SCORECARD_TOTAL_POINTS}</Text>
        </Text>
        <RatingBadge rating={scorecard.rating} label={scorecard.ratingLabel} />
      </View>

      {/* Meta */}
      <View style={{ gap: 2 }}>
        <Text style={styles.meta}>Week of {formatShortDate(scorecard.weekOf)}</Text>
        {scorecard.projectNumber ? <Text style={styles.meta}>Project {scorecard.projectNumber}</Text> : null}
        {scorecard.superintendentName ? (
          <Text style={styles.meta}>Superintendent: {scorecard.superintendentName}</Text>
        ) : null}
        {scorecard.pmName ? <Text style={styles.meta}>PM: {scorecard.pmName}</Text> : null}
        <Text style={styles.meta}>
          Submitted{scorecard.submittedByName ? ` by ${scorecard.submittedByName}` : ""} · {formatShortDate(scorecard.submittedAt)}
        </Text>
      </View>

      {/* Section scores — all 7 always render; sections absent from items show 0/maxPoints. */}
      <View style={{ gap: theme.space.sm }}>
        <SectionLabel>Section scores</SectionLabel>
        {sections.map((row) => (
          <View key={row.key} style={styles.sectionRow}>
            <View style={{ flex: 1 }}>
              <Text style={styles.sectionTitle}>{row.title}</Text>
              {row.note ? <Text style={styles.sectionNote}>{row.note}</Text> : null}
            </View>
            <Text style={styles.sectionPoints}>
              {row.points}/{row.maxPoints}
            </Text>
          </View>
        ))}
      </View>

      {/* Critical deficiencies — detail returns KEYS; map to labels. */}
      {deficiencies.length > 0 ? (
        <View style={{ gap: theme.space.sm }}>
          <SectionLabel>Critical deficiencies</SectionLabel>
          {deficiencies.map((key) => (
            <View key={key} style={styles.bulletRow}>
              <Text style={styles.bulletDot}>•</Text>
              <Text style={styles.bulletText}>{deficiencyLabel(key)}</Text>
            </View>
          ))}
        </View>
      ) : null}

      {/* Action items — free text, render raw. */}
      {actionItems.length > 0 ? (
        <View style={{ gap: theme.space.sm }}>
          <SectionLabel>Action items</SectionLabel>
          {actionItems.map((item, i) => (
            <View key={`${i}-${item}`} style={styles.bulletRow}>
              <Text style={styles.bulletDot}>•</Text>
              <Text style={styles.bulletText}>{item}</Text>
            </View>
          ))}
        </View>
      ) : null}

      {/* Evidence photos grouped by section. A null url → placeholder tile (no broken Image). */}
      {photoSections.length > 0 ? (
        <View style={{ gap: theme.space.md }}>
          <SectionLabel>Photos</SectionLabel>
          {photoSections.map((section) => (
            <View key={section.key} style={{ gap: theme.space.sm }}>
              <Text style={styles.photoGroup}>{section.title}</Text>
              <View style={styles.grid}>
                {section.photos.map((photo) => (
                  <Pressable
                    key={photo.id}
                    onPress={() => onOpenPhoto?.(photo)}
                    disabled={!photo.url}
                    accessibilityRole="imagebutton"
                    accessibilityLabel={photo.caption ?? "Scorecard photo"}
                    style={[styles.thumb, { width: thumb, height: thumb }]}
                  >
                    {photo.url ? (
                      <Image
                        testID={`scorecard-photo-image-${photo.id}`}
                        source={{ uri: photo.url }}
                        style={styles.image}
                        resizeMode="cover"
                      />
                    ) : (
                      <View testID={`scorecard-photo-placeholder-${photo.id}`} style={[styles.image, styles.placeholder]} />
                    )}
                  </Pressable>
                ))}
              </View>
            </View>
          ))}
        </View>
      ) : null}

      {/* Download PDF — ALWAYS rendered. The detail response carries no pdf-ready signal (server change
          out of scope), so there is nothing to pre-hide on. A still-generating PDF 404s and the screen
          shows a "still generating" toast instead of crashing (scorecardDownloadErrorMessage). */}
      <Button title="Download PDF" variant="ghost" loading={downloadingPdf} onPress={onDownloadPdf} />
    </View>
  );
}

const styles = StyleSheet.create({
  summary: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: theme.space.md },
  score: { fontFamily: theme.font.bold, fontSize: 34, color: theme.color.textPrimary },
  scoreMax: { fontFamily: theme.font.semibold, fontSize: 18, color: theme.color.textMuted },
  meta: { fontFamily: theme.font.body, fontSize: 13, color: theme.color.textMuted },
  sectionRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.space.md,
    backgroundColor: theme.color.surfaceCard,
    borderWidth: 1,
    borderColor: theme.color.border,
    borderRadius: theme.radius.md,
    padding: theme.space.md,
  },
  sectionTitle: { fontFamily: theme.font.semibold, fontSize: 15, color: theme.color.textPrimary },
  sectionNote: { fontFamily: theme.font.body, fontSize: 13, color: theme.color.textMuted, marginTop: 2 },
  sectionPoints: { fontFamily: theme.font.bold, fontSize: 15, color: theme.color.textPrimary },
  bulletRow: { flexDirection: "row", gap: theme.space.sm, alignItems: "flex-start" },
  bulletDot: { fontFamily: theme.font.bold, fontSize: 15, color: theme.color.brandRed, lineHeight: 20 },
  bulletText: { flex: 1, fontFamily: theme.font.body, fontSize: 14, color: theme.color.textPrimary, lineHeight: 20 },
  photoGroup: { fontFamily: theme.font.semibold, fontSize: 14, color: theme.color.textPrimary },
  grid: { flexDirection: "row", flexWrap: "wrap", gap: GRID_GAP },
  thumb: { borderRadius: theme.radius.sm, overflow: "hidden", backgroundColor: theme.color.surfaceMuted },
  image: { width: "100%", height: "100%", backgroundColor: theme.color.surfaceMuted },
  placeholder: { borderWidth: 1, borderColor: theme.color.border },
});
