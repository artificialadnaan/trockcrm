function titleCaseToken(value: string) {
  if (!value) return value;
  return value.charAt(0).toUpperCase() + value.slice(1).toLowerCase();
}

const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export function formatEnumLabel(value: string) {
  const trimmed = value.trim();
  if (!trimmed) return "";
  if (ISO_DATE_PATTERN.test(trimmed)) return trimmed;

  const lower = trimmed.toLowerCase();
  if (lower === "true") return "Yes";
  if (lower === "false") return "No";

  if (/[_-]/.test(trimmed)) {
    return trimmed
      .split(/[_-]+/)
      .filter(Boolean)
      .map(titleCaseToken)
      .join(" ");
  }

  if (/^[a-z][a-z0-9]*$/.test(trimmed)) {
    return trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
  }

  return trimmed;
}

export function formatDisplayValue(
  value: string | boolean | number | string[] | null | undefined,
  options: { formatStringEnums?: boolean } = {}
) {
  if (value == null) return "Unanswered";
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (typeof value === "number") return String(value);
  if (Array.isArray(value)) {
    return value.length > 0 ? value.map(formatEnumLabel).join(", ") : "Unanswered";
  }
  if (value.trim().length === 0) return "Unanswered";
  if (value.trim().toLowerCase() === "true") return "Yes";
  if (value.trim().toLowerCase() === "false") return "No";
  return options.formatStringEnums ? formatEnumLabel(value) : value.trim();
}
