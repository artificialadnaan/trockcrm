import type { LeadAnswerValue, LeadQuestionnaireNode } from "@/hooks/use-leads";

type QuestionNodeShape = Pick<LeadQuestionnaireNode, "key" | "inputType" | "options"> | {
  key: string;
  inputType: string | null;
  options?: unknown;
};

export const UNANSWERED_PLACEHOLDER_VALUE = "__unanswered__";
export const CLEAR_SELECTION_VALUE = "__clear__";
export const TYPE_OF_ACCESS_OPTIONS = ["Gated", "Not Gated", "Bobbed", "Other"] as const;
export const TYPE_OF_ACCESS_OTHER_DETAIL_KEY = "site_access_other_detail";

function isTypeOfAccessOption(value: string) {
  return TYPE_OF_ACCESS_OPTIONS.includes(value as (typeof TYPE_OF_ACCESS_OPTIONS)[number]);
}

export function getLeadQuestionnaireDisplayLabel(key: string, fallbackLabel: string) {
  if (key === "site_access") return "Type of access";
  if (key === TYPE_OF_ACCESS_OTHER_DETAIL_KEY) return "Type of access detail";
  if (key === "number_of_units") return "Number of Units Affected";
  return fallbackLabel;
}

export function isUnansweredPlaceholderValue(value: unknown): boolean {
  return typeof value === "string" && value.trim() === UNANSWERED_PLACEHOLDER_VALUE;
}

export function getNormalizedQuestionInputType(node: QuestionNodeShape) {
  if (node.key === "life_safety") return "boolean";
  if (node.key === "site_access") return "select";
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
  if (!node) return true;
  const inputType = getNormalizedQuestionInputType(node);
  return inputType === "boolean" || inputType === "select";
}

function getQuestionOptionValues(node: QuestionNodeShape | null | undefined): string[] {
  if (!node || !Array.isArray(node.options)) {
    return [];
  }

  return node.options.flatMap((option) => {
    if (typeof option === "string") {
      return [option];
    }
    if (
      option &&
      typeof option === "object" &&
      "value" in option &&
      typeof (option as { value?: unknown }).value === "string"
    ) {
      return [(option as { value: string }).value];
    }
    return [];
  });
}

function isSelectClearSentinel(
  value: unknown,
  node: QuestionNodeShape | null | undefined
): value is typeof CLEAR_SELECTION_VALUE {
  if (typeof value !== "string" || value.trim() !== CLEAR_SELECTION_VALUE) {
    return false;
  }

  return !getQuestionOptionValues(node).includes(CLEAR_SELECTION_VALUE);
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

  const normalizedAnswers = Object.fromEntries(
    Object.entries(answers).map(([key, value]) => {
      const node = nodeByKey.get(key);
      if (shouldNormalizeUnansweredPlaceholder(node) && isUnansweredPlaceholderValue(value)) {
        return [key, null];
      }
      return [key, value];
    })
  );

  const rawTypeOfAccess = normalizedAnswers.site_access;
  const rawTypeOfAccessDetail = normalizedAnswers[TYPE_OF_ACCESS_OTHER_DETAIL_KEY];
  const typeOfAccess =
    typeof rawTypeOfAccess === "string"
      ? rawTypeOfAccess.trim()
      : null;
  const typeOfAccessDetail =
    typeof rawTypeOfAccessDetail === "string"
      ? rawTypeOfAccessDetail.trim()
      : "";

  if (!typeOfAccess) {
    return normalizedAnswers;
  }

  if (typeOfAccess === "Other") {
    return {
      ...normalizedAnswers,
      [TYPE_OF_ACCESS_OTHER_DETAIL_KEY]: typeOfAccessDetail,
    };
  }

  if (isTypeOfAccessOption(typeOfAccess)) {
    return normalizedAnswers;
  }

  return {
    ...normalizedAnswers,
    site_access: "Other",
    [TYPE_OF_ACCESS_OTHER_DETAIL_KEY]: typeOfAccessDetail || typeOfAccess,
  };
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
      if (!trimmed || trimmed === UNANSWERED_PLACEHOLDER_VALUE || isSelectClearSentinel(trimmed, node)) {
        return null;
      }
      if (trimmed === "true") return true;
      if (trimmed === "false") return false;
    }
    return value ?? null;
  }

  if (inputType === "select") {
    if (isSelectClearSentinel(value, node)) {
      return null;
    }
    return normalizeDropdownAnswerForDisplay(value) ?? null;
  }

  return value ?? null;
}
