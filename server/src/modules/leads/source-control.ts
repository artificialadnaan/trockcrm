import { LEAD_SOURCE_CATEGORIES, type LeadSourceCategory } from "@trock-crm/shared/types";
import { AppError } from "../../middleware/error-handler.js";

export { LEAD_SOURCE_CATEGORIES };

export interface LeadSourceInput {
  sourceCategory?: LeadSourceCategory | string | null;
  sourceDetail?: string | null;
}

export function normalizeLeadSourceInput(source: string | null | undefined): {
  sourceCategory: LeadSourceCategory | null;
  sourceDetail: string | null;
} {
  const trimmed = source?.trim() ?? "";
  if (!trimmed) {
    return { sourceCategory: null, sourceDetail: null };
  }

  const exactCategory = LEAD_SOURCE_CATEGORIES.find(
    (category) => category.toLowerCase() === trimmed.toLowerCase()
  );

  if (exactCategory) {
    return {
      sourceCategory: exactCategory,
      sourceDetail: null,
    };
  }

  return {
    sourceCategory: "Other",
    sourceDetail: trimmed,
  };
}

export function validateLeadSourceInput(input: LeadSourceInput): {
  sourceCategory: LeadSourceCategory | null;
  sourceDetail: string | null;
} {
  const sourceCategory = input.sourceCategory ?? null;
  const sourceDetail = input.sourceDetail?.trim() || null;

  if (sourceCategory == null || sourceCategory === "") {
    return {
      sourceCategory: null,
      sourceDetail: null,
    };
  }

  if (!LEAD_SOURCE_CATEGORIES.includes(sourceCategory as LeadSourceCategory)) {
    throw new AppError(400, "Source category is invalid");
  }

  if (sourceCategory === "Other" && !sourceDetail) {
    throw new AppError(400, "Source detail is required when source is Other");
  }

  return {
    sourceCategory: sourceCategory as LeadSourceCategory,
    sourceDetail: sourceCategory === "Other" ? sourceDetail : null,
  };
}

export function resolveLeadSourceForWrite(input: LeadSourceInput & { source?: string | null }) {
  if (input.sourceCategory !== undefined || input.sourceDetail !== undefined) {
    return validateLeadSourceInput(input);
  }

  return normalizeLeadSourceInput(input.source);
}
