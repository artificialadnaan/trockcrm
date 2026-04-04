import { TASK_RULES } from "./config.js";
import type {
  RuleEvaluationOutcome,
  TaskBusinessKey,
  TaskRecord,
  TaskRuleDefinition,
  TaskRulePersistence,
  TaskRuleContext,
} from "./types.js";

function keyToString(key: TaskBusinessKey): string {
  return `${key.originRule}:${key.dedupeKey}`;
}

export async function evaluateTaskRules(
  context: TaskRuleContext,
  persistence: TaskRulePersistence,
  rules: TaskRuleDefinition[] = TASK_RULES
): Promise<RuleEvaluationOutcome[]> {
  const outcomes: RuleEvaluationOutcome[] = [];
  const seenKeys = new Set<string>();

  for (const rule of rules) {
    if (rule.sourceEvent !== context.sourceEvent) {
      outcomes.push({ ruleId: rule.id, action: "skipped", reason: "source_event_mismatch" });
      continue;
    }

    const dedupeKey = rule.buildDedupeKey(context);
    if (!dedupeKey) {
      outcomes.push({ ruleId: rule.id, action: "skipped", reason: "missing_dedupe_key" });
      continue;
    }

    const businessKey: TaskBusinessKey = { originRule: rule.id, dedupeKey };
    const businessKeyString = keyToString(businessKey);

    if (seenKeys.has(businessKeyString)) {
      outcomes.push({ ruleId: rule.id, businessKey, action: "skipped", reason: "duplicate_in_pass" });
      continue;
    }
    seenKeys.add(businessKeyString);

    const draft = await rule.buildTask(context);
    if (!draft) {
      outcomes.push({ ruleId: rule.id, businessKey, action: "skipped", reason: "no_task_draft" });
      continue;
    }

    const existing = await persistence.findOpenTaskByBusinessKey(businessKey);
    const persisted: TaskRecord = existing
      ? await persistence.updateTask(existing.id, draft)
      : await persistence.insertTask(draft);

    outcomes.push({
      ruleId: rule.id,
      businessKey,
      action: existing ? "updated" : "created",
      taskId: persisted.id,
    });
  }

  return outcomes;
}
