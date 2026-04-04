import { TASK_RULES } from "./config.js";
import type {
  RuleEvaluationOutcome,
  TaskBusinessKey,
  TaskRecord,
  TaskResolutionStateRecord,
  TaskRuleDefinition,
  TaskRulePersistence,
  TaskRuleContext,
} from "./types.js";

function makeBusinessKeyKey(key: TaskBusinessKey): readonly [string, string] {
  return [key.originRule, key.dedupeKey] as const;
}

function makeSkipReason(code: string, detail: string) {
  return { code, detail };
}

function addSuppressionWindow(resolvedAt: Date, suppressionWindowDays: number): Date {
  return new Date(resolvedAt.getTime() + suppressionWindowDays * 24 * 60 * 60 * 1000);
}

function isResolutionStateActive(
  state: TaskResolutionStateRecord,
  now: Date,
  suppressionWindowDays: number
): boolean {
  const suppressedUntil = state.suppressedUntil
    ? new Date(state.suppressedUntil)
    : state.resolvedAt
      ? addSuppressionWindow(new Date(state.resolvedAt), suppressionWindowDays)
      : null;

  if (state.resolutionStatus === "completed") {
    return suppressedUntil != null && suppressedUntil > now;
  }

  if (state.resolutionStatus === "suppressed") {
    return suppressedUntil != null && suppressedUntil > now;
  }

  if (state.resolutionStatus === "dismissed") {
    return suppressedUntil != null && suppressedUntil > now;
  }

  return false;
}

export async function evaluateTaskRules(
  context: TaskRuleContext,
  persistence: TaskRulePersistence,
  rules: TaskRuleDefinition[] = TASK_RULES
): Promise<RuleEvaluationOutcome[]> {
  const outcomes: RuleEvaluationOutcome[] = [];
  const seenKeys = new Map<string, Set<string>>();

  for (const rule of rules) {
    if (rule.sourceEvent !== context.sourceEvent) {
      outcomes.push({
        ruleId: rule.id,
        action: "skipped",
        reason: makeSkipReason("source_event_mismatch", context.sourceEvent),
      });
      continue;
    }

    const dedupeKey = rule.buildDedupeKey(context);
    if (!dedupeKey) {
      outcomes.push({
        ruleId: rule.id,
        action: "skipped",
        reason: makeSkipReason("missing_dedupe_key", rule.id),
      });
      continue;
    }

    const businessKey: TaskBusinessKey = { originRule: rule.id, dedupeKey };
    const compositeKey = makeBusinessKeyKey(businessKey);
    const seenByOrigin = seenKeys.get(compositeKey[0]);
    if (seenByOrigin?.has(compositeKey[1])) {
      outcomes.push({
        ruleId: rule.id,
        businessKey,
        action: "skipped",
        reason: makeSkipReason("duplicate_in_pass", `${businessKey.originRule}|${businessKey.dedupeKey}`),
      });
      continue;
    }
    if (seenByOrigin) {
      seenByOrigin.add(compositeKey[1]);
    } else {
      seenKeys.set(compositeKey[0], new Set([compositeKey[1]]));
    }

    const resolutionState = await persistence.findResolutionStateByBusinessKey(businessKey);
    if (resolutionState && isResolutionStateActive(resolutionState, context.now, rule.suppressionWindowDays)) {
      outcomes.push({
        ruleId: rule.id,
        businessKey,
        action: "skipped",
        reason: makeSkipReason("resolution_state_suppressed", `${businessKey.originRule}|${businessKey.dedupeKey}`),
      });
      continue;
    }

    const draft = await rule.buildTask(context);
    if (!draft) {
      outcomes.push({
        ruleId: rule.id,
        businessKey,
        action: "skipped",
        reason: makeSkipReason("no_task_draft", rule.id),
      });
      continue;
    }

    if (draft.assignedTo == null) {
      outcomes.push({
        ruleId: rule.id,
        businessKey,
        action: "skipped",
        reason: makeSkipReason("no_assignment_candidate", rule.id),
      });
      continue;
    }

    const existing = await persistence.findOpenTaskByBusinessKey(businessKey);
    const draftForPersistence = existing
      ? { ...draft, status: existing.status }
      : draft;
    const persisted: TaskRecord = existing
      ? await persistence.updateTask(existing.id, draftForPersistence)
      : await persistence.insertTask(draftForPersistence);

    outcomes.push({
      ruleId: rule.id,
      businessKey,
      action: existing ? "updated" : "created",
      taskId: persisted.id,
    });
  }

  return outcomes;
}
