import type {
  PriorityScoreInput,
  PriorityScoreResult,
  TaskPriorityBand,
} from "./types.js";

function clampScore(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, Math.round(value)));
}

export function mapTaskPriorityBand(score: number): TaskPriorityBand {
  if (score >= 80) return "urgent";
  if (score >= 60) return "high";
  if (score >= 35) return "normal";
  return "low";
}

export function scoreTaskPriority(input: PriorityScoreInput): PriorityScoreResult {
  const score = clampScore(
    input.dueProximity +
      input.stageRisk +
      input.staleAge +
      input.unreadInbound +
      input.dealValue
  );

  return {
    score,
    band: mapTaskPriorityBand(score),
  };
}
