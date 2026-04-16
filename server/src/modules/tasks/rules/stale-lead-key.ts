export function normalizeStaleLeadEpisodeTimestamp(
  value: Date | string | null | undefined
): string | null {
  if (!value) return null;

  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;

  return date.toISOString();
}

export function buildStaleLeadDedupeKey(
  leadId: string | null | undefined,
  stageEnteredAt: Date | string | null | undefined
): string | null {
  if (!leadId) return null;

  const normalizedStageEnteredAt = normalizeStaleLeadEpisodeTimestamp(stageEnteredAt);
  if (!normalizedStageEnteredAt) return null;

  return `lead:${leadId}:stage_entered:${normalizedStageEnteredAt}`;
}
