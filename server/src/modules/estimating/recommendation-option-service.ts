export interface RecommendationOptionCandidate {
  optionLabel: string;
  catalogItemId?: string | null;
  localCatalogItemId?: string | null;
  normalizedCustomItemKey?: string | null;
  score: number;
  historicalSelectionCount?: number;
  unitCompatibilityScore?: number;
  absolutePriceDeviation?: number;
  stableId?: string | null;
  evidenceJson?: Record<string, unknown>;
}

export interface BuildRecommendationOptionSetInput {
  sectionName: string | null;
  normalizedIntent: string;
  sourceRowIdentity: string;
  candidates: RecommendationOptionCandidate[];
}

export interface RecommendationOptionRow {
  rank: number;
  optionLabel: string;
  optionKind: "recommended" | "alternate";
  catalogItemId: string | null;
  localCatalogItemId: string | null;
  normalizedCustomItemKey: string | null;
  stableId: string;
  score: number;
  historicalSelectionCount: number;
  unitCompatibilityScore: number;
  absolutePriceDeviation: number;
  evidenceJson: Record<string, unknown>;
}

export interface BuildRecommendationOptionSetResult {
  optionRows: RecommendationOptionRow[];
  recommendedOption: RecommendationOptionRow | null;
  alternateOptions: RecommendationOptionRow[];
  duplicateGroupMetadata: {
    sectionName: string | null;
    normalizedIntent: string;
    sourceRowIdentity: string;
    duplicateKeys: string[];
    suppressedCount: number;
  };
  rationaleJson: {
    sectionName: string | null;
    normalizedIntent: string;
    sourceRowIdentity: string;
    rankedCandidates: Array<{
      rank: number;
      optionLabel: string;
      optionKind: "recommended" | "alternate";
      score: number;
      historicalSelectionCount: number;
      unitCompatibilityScore: number;
      absolutePriceDeviation: number;
      stableId: string;
    }>;
    duplicateGroupMetadata: {
      sectionName: string | null;
      normalizedIntent: string;
      sourceRowIdentity: string;
      duplicateKeys: string[];
      suppressedCount: number;
    };
  };
}

function normalizeSortKey(value: string | null | undefined) {
  return (value ?? "").trim().toLowerCase();
}

function normalizeCandidateKey(candidate: RecommendationOptionCandidate) {
  if (candidate.catalogItemId) {
    return `catalog:${candidate.catalogItemId}`;
  }

  if (candidate.normalizedCustomItemKey) {
    return `custom:${normalizeSortKey(candidate.normalizedCustomItemKey)}`;
  }

  return `label:${normalizeSortKey(candidate.optionLabel)}`;
}

function buildStableId(candidate: RecommendationOptionCandidate) {
  return (
    candidate.stableId ??
    candidate.catalogItemId ??
    candidate.localCatalogItemId ??
    candidate.normalizedCustomItemKey ??
    candidate.optionLabel
  );
}

function compareCandidates(a: RecommendationOptionCandidate, b: RecommendationOptionCandidate) {
  const scoreDelta = b.score - a.score;
  if (scoreDelta !== 0) return scoreDelta;

  const historicalDelta = (b.historicalSelectionCount ?? 0) - (a.historicalSelectionCount ?? 0);
  if (historicalDelta !== 0) return historicalDelta;

  const unitCompatibilityDelta = (b.unitCompatibilityScore ?? 0) - (a.unitCompatibilityScore ?? 0);
  if (unitCompatibilityDelta !== 0) return unitCompatibilityDelta;

  const priceDeviationDelta = (a.absolutePriceDeviation ?? 0) - (b.absolutePriceDeviation ?? 0);
  if (priceDeviationDelta !== 0) return priceDeviationDelta;

  return normalizeSortKey(buildStableId(a)).localeCompare(normalizeSortKey(buildStableId(b)));
}

export function buildRecommendationOptionSet(
  input: BuildRecommendationOptionSetInput
): BuildRecommendationOptionSetResult {
  const duplicateKeys = new Set<string>();
  const dedupedCandidates: RecommendationOptionCandidate[] = [];
  const seen = new Map<string, RecommendationOptionCandidate>();

  for (const candidate of [...input.candidates].sort(compareCandidates)) {
    const key = normalizeCandidateKey(candidate);
    const existing = seen.get(key);

    if (existing) {
      duplicateKeys.add(key);
      continue;
    }

    seen.set(key, candidate);
    dedupedCandidates.push(candidate);
  }

  const rankedCandidates = dedupedCandidates.slice(0, 5).map((candidate, index) => {
    const stableId = buildStableId(candidate);

    return {
      rank: index + 1,
      optionLabel: candidate.optionLabel,
      optionKind: index === 0 ? "recommended" : "alternate",
      catalogItemId: candidate.catalogItemId ?? null,
      localCatalogItemId: candidate.localCatalogItemId ?? null,
      normalizedCustomItemKey: candidate.normalizedCustomItemKey ?? null,
      stableId,
      score: candidate.score,
      historicalSelectionCount: candidate.historicalSelectionCount ?? 0,
      unitCompatibilityScore: candidate.unitCompatibilityScore ?? 0,
      absolutePriceDeviation: candidate.absolutePriceDeviation ?? 0,
      evidenceJson: candidate.evidenceJson ?? {},
    } satisfies RecommendationOptionRow;
  });

  const duplicateGroupMetadata = {
    sectionName: input.sectionName,
    normalizedIntent: input.normalizedIntent,
    sourceRowIdentity: input.sourceRowIdentity,
    duplicateKeys: Array.from(duplicateKeys).sort(),
    suppressedCount: input.candidates.length - dedupedCandidates.length,
  };

  return {
    optionRows: rankedCandidates,
    recommendedOption: rankedCandidates[0] ?? null,
    alternateOptions: rankedCandidates.slice(1),
    duplicateGroupMetadata,
    rationaleJson: {
      sectionName: input.sectionName,
      normalizedIntent: input.normalizedIntent,
      sourceRowIdentity: input.sourceRowIdentity,
      rankedCandidates: rankedCandidates.map((candidate) => ({
        rank: candidate.rank,
        optionLabel: candidate.optionLabel,
        optionKind: candidate.optionKind,
        score: candidate.score,
        historicalSelectionCount: candidate.historicalSelectionCount,
        unitCompatibilityScore: candidate.unitCompatibilityScore,
        absolutePriceDeviation: candidate.absolutePriceDeviation,
        stableId: candidate.stableId,
      })),
      duplicateGroupMetadata,
    },
  };
}

