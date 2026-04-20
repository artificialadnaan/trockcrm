import type { SalesHygieneIssueRow } from "@trock-crm/shared/types";

type HygieneRecord = {
  entityType: "lead" | "deal";
  id: string;
  name: string;
  assignedRepId: string;
  assignedRepName: string;
  stageId: string;
  forecastWindow: string | null;
  forecastCategory: string | null;
  forecastConfidencePercent: number | null;
  nextStep: string | null;
  nextMilestoneAt: string | Date | null;
  lastActivityAt: string | Date | null;
  updatedAt: string | Date;
};

function daysSince(value: string | Date | null, now: Date) {
  if (!value) return Number.POSITIVE_INFINITY;
  const ts = value instanceof Date ? value.getTime() : new Date(value).getTime();
  return Math.floor((now.getTime() - ts) / 86_400_000);
}

export function evaluateSalesHygieneRecords(
  records: HygieneRecord[],
  options: { now?: Date; staleStageDays?: number; staleActivityDays?: number } = {}
): SalesHygieneIssueRow[] {
  const now = options.now ?? new Date();
  const staleStageDays = options.staleStageDays ?? 21;
  const staleActivityDays = options.staleActivityDays ?? 14;

  return records
    .map((record) => {
      const issueTypes: string[] = [];

      if (!record.forecastWindow) issueTypes.push("missing_forecast_window");
      if (!record.forecastCategory) issueTypes.push("missing_forecast_category");
      if (record.forecastConfidencePercent == null) issueTypes.push("missing_forecast_confidence");
      if (!record.nextStep?.trim()) issueTypes.push("missing_next_step");
      if (!record.nextMilestoneAt) issueTypes.push("missing_next_milestone");
      if (daysSince(record.updatedAt, now) > staleStageDays) issueTypes.push("stale_stage");
      if (daysSince(record.lastActivityAt, now) > staleActivityDays) issueTypes.push("no_recent_activity");

      if (issueTypes.length === 0) return null;

      return {
        entityType: record.entityType,
        id: record.id,
        name: record.name,
        assignedRepId: record.assignedRepId,
        assignedRepName: record.assignedRepName,
        issueTypes,
        stageId: record.stageId,
        nextStep: record.nextStep,
        nextMilestoneAt: record.nextMilestoneAt
          ? new Date(record.nextMilestoneAt).toISOString()
          : null,
        lastActivityAt: record.lastActivityAt ? new Date(record.lastActivityAt).toISOString() : null,
        updatedAt: new Date(record.updatedAt).toISOString(),
      } satisfies SalesHygieneIssueRow;
    })
    .filter((row): row is SalesHygieneIssueRow => row !== null)
    .sort((left, right) => right.issueTypes.length - left.issueTypes.length);
}
