import type { LeadAnswerValue, LeadQuestionnaireNode } from "@/hooks/use-leads";

type QuestionNodeShape = Pick<LeadQuestionnaireNode, "key" | "inputType" | "options"> | {
  key: string;
  inputType: string | null;
  options?: unknown;
};

export const UNANSWERED_PLACEHOLDER_VALUE = "__unanswered__";
export const CLEAR_SELECTION_VALUE = "__clear__";

export function isUnansweredPlaceholderValue(value: unknown): boolean {
  return typeof value === "string" && value.trim() === UNANSWERED_PLACEHOLDER_VALUE;
}

export function getNormalizedQuestionInputType(node: QuestionNodeShape) {
  if (node.key === "life_safety") return "boolean";
  if (node.inputType === "textarea") return "textarea";
  if (node.inputType === "boolean") return "boolean";
  if (node.inputType === "date") return "date";
  if (node.inputType === "multiselect") return "multiselect";
  if (node.inputType === "currency") return "currency";
  if (node.inputType === "number") return "number";
  if (Array.isArray(node.options) && node.options.length > 0) return "select";
  return "text";
}

export function shouldNormalizeUnansweredPlaceholder(node: QuestionNodeShape | null | undefined) {
  if (!node) return false;
  const inputType = getNormalizedQuestionInputType(node);
  return inputType === "boolean" || inputType === "select";
}

export function normalizeDropdownAnswerForDisplay(value: LeadAnswerValue | undefined): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  if (!trimmed || trimmed === UNANSWERED_PLACEHOLDER_VALUE) {
    return undefined;
  }

  return trimmed;
}

export function normalizeBooleanAnswerForDisplay(value: LeadAnswerValue | undefined): string | undefined {
  if (typeof value === "boolean") {
    return String(value);
  }

  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim().toLowerCase();
  if (!trimmed || trimmed === UNANSWERED_PLACEHOLDER_VALUE) {
    return undefined;
  }

  if (trimmed === "true" || trimmed === "false") {
    return trimmed;
  }

  return undefined;
}

export function normalizeStoredQuestionAnswers(
  answers: Record<string, LeadAnswerValue> | null | undefined,
  nodes?: readonly QuestionNodeShape[] | null
): Record<string, LeadAnswerValue> {
  if (!answers) {
    return {};
  }

  const nodeByKey = new Map((nodes ?? []).map((node) => [node.key, node]));

  return Object.fromEntries(
    Object.entries(answers).map(([key, value]) => {
      const node = nodeByKey.get(key);
      if (shouldNormalizeUnansweredPlaceholder(node) && isUnansweredPlaceholderValue(value)) {
        return [key, null];
      }
      return [key, value];
    })
  );
}

export function sanitizeQuestionAnswerForSave(
  node: QuestionNodeShape,
  value: LeadAnswerValue | undefined
): LeadAnswerValue {
  const inputType = getNormalizedQuestionInputType(node);

  if (inputType === "boolean") {
    if (typeof value === "boolean") {
      return value;
    }
    if (typeof value === "string") {
      const trimmed = value.trim().toLowerCase();
      if (!trimmed || trimmed === UNANSWERED_PLACEHOLDER_VALUE || trimmed === CLEAR_SELECTION_VALUE) {
        return null;
      }
      if (trimmed === "true") return true;
      if (trimmed === "false") return false;
    }
    return value ?? null;
  }

  if (inputType === "select") {
    if (typeof value === "string" && value.trim() === CLEAR_SELECTION_VALUE) {
      return null;
    }
    return normalizeDropdownAnswerForDisplay(value) ?? null;
  }

  return value ?? null;
}
