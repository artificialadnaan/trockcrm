export const CANONICAL_DEAL_SHAPE_FIELDS = [
  "id",
  "dealNumber",
  "name",
  "stageId",
  "assignedRepId",
  "primaryContactId",
  "companyId",
  "propertyId",
  "sourceLeadId",
  "ddEstimate",
  "bidEstimate",
  "awardedAmount",
  "changeOrderTotal",
  "description",
  "propertyAddress",
  "propertyCity",
  "propertyState",
  "propertyZip",
  "projectTypeId",
  "regionId",
  "source",
  "winProbability",
  "expectedCloseDate",
  "workflowRoute",
  "pipelineDisposition",
  "isBidBoardOwned",
  "isReadOnlyMirror",
  "isReadOnlySyncDirty",
  "hubspotDealId",
  "proposalStatus",
  "proposalRevisionCount",
  "stageEnteredAt",
  "isActive",
  "createdAt",
  "updatedAt",
] as const;

export type CanonicalDealShapeField = (typeof CANONICAL_DEAL_SHAPE_FIELDS)[number];
export type CanonicalDealShape = Record<CanonicalDealShapeField, unknown>;

const DEFAULTS: Partial<CanonicalDealShape> = {
  primaryContactId: null,
  companyId: null,
  propertyId: null,
  sourceLeadId: null,
  ddEstimate: null,
  bidEstimate: null,
  awardedAmount: null,
  changeOrderTotal: "0",
  description: null,
  propertyAddress: null,
  propertyCity: null,
  propertyState: null,
  propertyZip: null,
  projectTypeId: null,
  regionId: null,
  source: "HubSpot",
  winProbability: null,
  expectedCloseDate: null,
  workflowRoute: "normal",
  pipelineDisposition: "deals",
  isBidBoardOwned: false,
  isReadOnlyMirror: false,
  isReadOnlySyncDirty: false,
  hubspotDealId: null,
  proposalStatus: "not_started",
  proposalRevisionCount: 0,
  isActive: true,
};

export function normalizeDealShape(row: Record<string, unknown>): CanonicalDealShape {
  const normalized = {} as CanonicalDealShape;
  for (const field of CANONICAL_DEAL_SHAPE_FIELDS) {
    normalized[field] = row[field] ?? DEFAULTS[field] ?? null;
  }
  return normalized;
}

export function dealShapeKeys(row: Record<string, unknown>) {
  return Object.keys(normalizeDealShape(row)).sort();
}

export function diffDealShapeFields(newDeal: Record<string, unknown>, importedDeal: Record<string, unknown>) {
  const left = normalizeDealShape(newDeal);
  const right = normalizeDealShape(importedDeal);
  return CANONICAL_DEAL_SHAPE_FIELDS.map((field) => ({
    field,
    newPresent: left[field] !== null && left[field] !== undefined,
    importedPresent: right[field] !== null && right[field] !== undefined,
    newType: left[field] === null ? "null" : typeof left[field],
    importedType: right[field] === null ? "null" : typeof right[field],
  }));
}
