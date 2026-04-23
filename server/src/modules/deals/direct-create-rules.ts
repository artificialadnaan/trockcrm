export interface DirectDealCreateInput {
  migrationMode?: boolean;
  sourceLeadId?: string | null;
  companyId?: string | null;
  propertyId?: string | null;
}

export function canCreateDealWithoutSourceLead(input: DirectDealCreateInput) {
  if (input.migrationMode) return true;
  if (input.sourceLeadId) return true;
  return Boolean(input.companyId && input.propertyId);
}
