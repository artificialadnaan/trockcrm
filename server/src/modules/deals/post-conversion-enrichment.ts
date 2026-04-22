export type PostConversionEnrichmentField =
  | "projectTypeId"
  | "regionId"
  | "expectedCloseDate"
  | "nextStep";

export type PostConversionEnrichmentState = {
  applies: boolean;
  isComplete: boolean;
  requiredFields: PostConversionEnrichmentField[];
  missingFields: PostConversionEnrichmentField[];
};

type DealLike = {
  sourceLeadId?: string | null;
  isActive?: boolean;
  nextStep?: string | null;
  projectTypeId?: string | null;
  regionId?: string | null;
  expectedCloseDate?: string | null;
};

type StageLike = {
  slug?: string | null;
  isTerminal?: boolean | null;
} | null | undefined;

const REQUIRED_FIELDS: PostConversionEnrichmentField[] = [
  "projectTypeId",
  "regionId",
  "expectedCloseDate",
  "nextStep",
];

function isBlank(value: unknown): boolean {
  return value == null || (typeof value === "string" && value.trim().length === 0);
}

function isCompleteField(deal: DealLike, field: PostConversionEnrichmentField): boolean {
  if (field === "nextStep") {
    return !isBlank(deal.nextStep);
  }

  return !isBlank(deal[field]);
}

function isConvertedDeal(deal: DealLike): boolean {
  return Boolean(deal.sourceLeadId);
}

function isManualOpportunityDeal(deal: DealLike, currentStage: StageLike): boolean {
  return !isConvertedDeal(deal) && currentStage?.slug === "opportunity";
}

export function evaluatePostConversionEnrichment(
  deal: DealLike,
  currentStage: StageLike
): PostConversionEnrichmentState {
  const isTerminal = Boolean(currentStage?.isTerminal);
  const isActive = deal.isActive === true;
  const missingFields = REQUIRED_FIELDS.filter((field) => !isCompleteField(deal, field));
  const isComplete = missingFields.length === 0;

  const applies =
    isActive &&
    !isTerminal &&
    !isComplete &&
    (isConvertedDeal(deal) || isManualOpportunityDeal(deal, currentStage));

  return {
    applies,
    isComplete,
    requiredFields: REQUIRED_FIELDS,
    missingFields,
  };
}
