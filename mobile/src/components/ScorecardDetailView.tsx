import React from "react";
import { Image, Pressable, StyleSheet, Text, View, useWindowDimensions } from "react-native";
import { theme } from "../theme/theme";
import { Button, SectionLabel } from "./ui";
import { RatingBadge } from "./RatingBadge";
import type { FieldScorecardDetail, FieldScorecardPhotoView } from "../api/types";
import {
  deficiencyLabel,
  formatShortDate,
  scorecardLeadershipRows,
  scorecardPhotoSections,
  scorecardSectionRows,
  scorecardLeadershipPhotoSections,
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

  const isLeadership = scorecard.kind === "leadership";
  // Leadership + V2 both score out of 10 (averageScore); V1 keeps the 0–100 total.
  const isV2 = scorecard.formVersion === 2;
  const displayScore = isV2 ? (scorecard.averageScore ?? scorecard.totalScore / 10).toFixed(1) : String(scorecard.totalScore);
  const displayMax = isV2 ? "10" : String(SCORECARD_TOTAL_POINTS);
  const canonicalProjectName = scorecard.projectName?.trim();
  const projectName =
    canonicalProjectName || (scorecard.projectNumber ? `Project ${scorecard.projectNumber}` : "Untitled project");

  return (
    <View style={{ gap: theme.space.lg }}>
      {/* Project identity stays visible in the standalone detail body even when a long header title truncates. */}
      <View style={{ gap: 2 }}>
        <Text style={styles.projectName} numberOfLines={2}>
          {projectName}
        </Text>
        {canonicalProjectName && scorecard.projectNumber ? <Text style={styles.meta}>Project {scorecard.projectNumber}</Text> : null}
        <Text style={styles.meta}>Week of {formatShortDate(scorecard.weekOf)}</Text>
      </View>

      {/* Score summary */}
      <View style={styles.summary}>
        <Text style={styles.score}>
          {displayScore}
          <Text style={styles.scoreMax}> / {displayMax}</Text>
        </Text>
        <RatingBadge rating={scorecard.rating} label={scorecard.ratingLabel} />
      </View>

      {/* Meta. Leadership: the Evaluator IS whoever submitted (server-stamped submittedByName). */}
      <View style={{ gap: 2 }}>
        {isLeadership ? (
          <Text style={styles.meta}>
            Evaluator: {scorecard.submittedByName || "—"} · {formatShortDate(scorecard.submittedAt)}
          </Text>
        ) : null}
        {scorecard.superintendentName ? (
          <Text style={styles.meta}>Superintendent: {scorecard.superintendentName}</Text>
        ) : null}
        {scorecard.pmName ? <Text style={styles.meta}>PM: {scorecard.pmName}</Text> : null}
        {!isLeadership ? (
          <Text style={styles.meta}>
            Submitted{scorecard.submittedByName ? ` by ${scorecard.submittedByName}` : ""} · {formatShortDate(scorecard.submittedAt)}
          </Text>
        ) : null}
      </View>

      {isLeadership ? (
        <LeadershipBody scorecard={scorecard} thumb={thumb} onOpenPhoto={onOpenPhoto} />
      ) : (
        <ProjectBody scorecard={scorecard} isV2={isV2} thumb={thumb} onOpenPhoto={onOpenPhoto} />
      )}

      {/* Download PDF — ALWAYS rendered. The detail response carries no pdf-ready signal (server change
          out of scope), so there is nothing to pre-hide on. A still-generating PDF 404s and the screen
          shows a "still generating" toast instead of crashing (scorecardDownloadErrorMessage). */}
      <Button title="Download PDF" variant="ghost" loading={downloadingPdf} onPress={onDownloadPdf} />
    </View>
  );
}

/** Project (V1/V2) body: section scores, critical deficiencies, action items, signatures (V2), photos. */
function ProjectBody({
  scorecard,
  isV2,
  thumb,
  onOpenPhoto,
}: {
  scorecard: FieldScorecardDetail;
  isV2: boolean;
  thumb: number;
  onOpenPhoto?: (photo: FieldScorecardPhotoView) => void;
}) {
  const sections = scorecardSectionRows(scorecard.items);
  const photoSections = scorecardPhotoSections(scorecard.photos);
  const deficiencies = scorecard.criticalDeficiencies;
  const actionItems = scorecard.actionItems;

  return (
    <>
      {/* Section scores — all 8 always render; sections absent from items show 0/maxPoints. */}
      <View style={{ gap: theme.space.sm }}>
        <SectionLabel>Section scores</SectionLabel>
        {sections.map((row) => (
          <View key={row.key} style={styles.sectionRow}>
            <View style={{ flex: 1 }}>
              <Text style={styles.sectionTitle}>{row.title}</Text>
              {row.note ? <Text style={styles.sectionNote}>{row.note}</Text> : null}
            </View>
            <Text style={styles.sectionPoints}>
              {row.points}/{isV2 ? 10 : row.maxPoints}
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
              <View style={{ flex: 1 }}>
                <Text style={styles.bulletText}>{deficiencyLabel(key)}</Text>
                {scorecard.criticalDeficiencyNotes?.[key] ? <Text style={styles.sectionNote}>{scorecard.criticalDeficiencyNotes[key]}</Text> : null}
              </View>
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

      {isV2 ? (
        <View style={{ gap: theme.space.sm }}>
          <SectionLabel>Signatures</SectionLabel>
          <Text style={styles.bulletText}>Superintendent: {scorecard.superintendentSignature || "—"}</Text>
          <Text style={styles.bulletText}>Project manager: {scorecard.pmSignature || "—"}</Text>
        </View>
      ) : null}

      {/* Evidence photos grouped by section. A null url → placeholder tile (no broken Image). */}
      {photoSections.length > 0 ? (
        <View style={{ gap: theme.space.md }}>
          <SectionLabel>Photos</SectionLabel>
          {photoSections.map((section) => (
            <View key={section.key} style={{ gap: theme.space.sm }}>
              <Text style={styles.photoGroup}>{section.title}</Text>
              <PhotoGrid photos={section.photos} thumb={thumb} onOpenPhoto={onOpenPhoto} />
            </View>
          ))}
        </View>
      ) : null}
    </>
  );
}

/**
 * Leadership body: the 4 leadership category scores (+ comment notes), the Project Summary free text, and
 * category/Project Summary evidence photos. Leadership cards carry no signatures or critical deficiencies, so
 * neither section is rendered.
 */
function LeadershipBody({
  scorecard,
  thumb,
  onOpenPhoto,
}: {
  scorecard: FieldScorecardDetail;
  thumb: number;
  onOpenPhoto?: (photo: FieldScorecardPhotoView) => void;
}) {
  const rows = scorecardLeadershipRows(scorecard.items);
  const photoSections = scorecardLeadershipPhotoSections(scorecard.photos);

  return (
    <>
      {/* Category scores — all 4 always render (each rated 1-10); absent items show 0/10. */}
      <View style={{ gap: theme.space.sm }}>
        <SectionLabel>Category scores</SectionLabel>
        {rows.map((row) => (
          <View key={row.key} style={styles.sectionRow}>
            <View style={{ flex: 1 }}>
              <Text style={styles.sectionTitle}>{row.title}</Text>
              {row.note ? <Text style={styles.sectionNote}>{row.note}</Text> : null}
            </View>
            <Text style={styles.sectionPoints}>{row.points}/10</Text>
          </View>
        ))}
      </View>

      {/* Project Summary free text. */}
      <View style={{ gap: theme.space.sm }}>
        <SectionLabel>Project summary</SectionLabel>
        <Text style={styles.bulletText}>{scorecard.summary?.trim() || "No summary provided."}</Text>
      </View>

      {/* Category and Project Summary evidence photos. A null url → placeholder tile (no broken Image). */}
      {photoSections.length > 0 ? (
        <View style={{ gap: theme.space.md }}>
          <SectionLabel>Evidence</SectionLabel>
          {photoSections.map((section) => (
            <View key={section.key} style={{ gap: theme.space.sm }}>
              <Text style={styles.photoGroup}>{section.title}</Text>
              <PhotoGrid photos={section.photos} thumb={thumb} onOpenPhoto={onOpenPhoto} />
            </View>
          ))}
        </View>
      ) : null}
    </>
  );
}

/** Shared evidence-photo grid. A null url renders a placeholder tile rather than a broken <Image>. */
function PhotoGrid({
  photos,
  thumb,
  onOpenPhoto,
}: {
  photos: readonly FieldScorecardPhotoView[];
  thumb: number;
  onOpenPhoto?: (photo: FieldScorecardPhotoView) => void;
}) {
  return (
    <View style={styles.grid}>
      {photos.map((photo) => (
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
  );
}

const styles = StyleSheet.create({
  projectName: { fontFamily: theme.font.bold, fontSize: 20, lineHeight: 25, color: theme.color.textPrimary },
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
