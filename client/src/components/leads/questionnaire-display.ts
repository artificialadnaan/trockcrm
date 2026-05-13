import { formatDisplayValue } from "@/lib/display-format";

export type QuestionAnswerValue = string | boolean | number | string[] | null | undefined;

export function formatQuestionAnswerValue(
  value: QuestionAnswerValue,
  options: { formatStringEnums?: boolean } = {}
) {
  return formatDisplayValue(value, options);
}

function normalizeRevealValue(value: unknown) {
  if (typeof value === "boolean") {
    return value ? "true" : "false";
  }
  if (value == null) {
    return "";
  }
  return String(value);
}

export function questionnaireRevealMatches(parentAnswer: unknown, parentOptionValue: string | null) {
  if (parentOptionValue == null) {
    if (typeof parentAnswer === "string") {
      return parentAnswer.trim().length > 0;
    }
    if (Array.isArray(parentAnswer)) {
      return parentAnswer.length > 0;
    }
    return Boolean(parentAnswer);
  }

  if (Array.isArray(parentAnswer)) {
    return parentAnswer.map(String).includes(parentOptionValue);
  }

  return normalizeRevealValue(parentAnswer) === parentOptionValue;
}

export function normalizeQuestionOptions(options: unknown): Array<{ value: string; label: string }> {
  if (!Array.isArray(options)) {
    return [];
  }

  return options
    .map((option) => {
      if (typeof option === "string") {
        return { value: option, label: option };
      }
      if (
        option &&
        typeof option === "object" &&
        "value" in option &&
        typeof (option as { value?: unknown }).value === "string"
      ) {
        const typedOption = option as { value: string; label?: unknown };
        return {
          value: typedOption.value,
          label: typeof typedOption.label === "string" ? typedOption.label : typedOption.value,
        };
      }
      return null;
    })
    .filter((option): option is { value: string; label: string } => option != null);
}
