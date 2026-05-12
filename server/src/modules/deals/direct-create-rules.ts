export interface DirectDealCreateInput {
  creationContext?: "direct" | "lead_conversion" | "migration";
  sourceLeadWriteMode?: "direct" | "lead_conversion";
  migrationMode?: boolean;
  sourceLeadId?: string | null;
  companyId?: string | null;
  propertyId?: string | null;
}

export type DealCreationOrigin = "direct" | "lead_conversion" | "migration";

export interface DealCreationPolicy {
  allowed: boolean;
  origin: DealCreationOrigin;
  reason?: string;
}

export function resolveDealCreationPolicy(input: DirectDealCreateInput): DealCreationPolicy {
  const origin: DealCreationOrigin =
    input.migrationMode || input.creationContext === "migration"
      ? "migration"
      : input.creationContext ?? (input.sourceLeadWriteMode === "lead_conversion" ? "lead_conversion" : "direct");

  if (origin === "migration") {
    return { allowed: true, origin };
  }

  if (origin === "lead_conversion") {
    return input.sourceLeadId && input.sourceLeadWriteMode === "lead_conversion"
      ? { allowed: true, origin }
      : {
          allowed: false,
          origin,
          reason: "sourceLeadId is required for lead conversion deal creation",
        };
  }

  if (input.sourceLeadId) {
    return {
      allowed: false,
      origin,
      reason: "Use the lead conversion endpoint to create deals from leads",
    };
  }

  return input.companyId && input.propertyId
    ? { allowed: true, origin }
    : {
        allowed: false,
        origin,
        reason: "Direct deal creation requires companyId and propertyId",
      };
}

export function canCreateDealWithoutSourceLead(input: DirectDealCreateInput) {
  return resolveDealCreationPolicy(input).allowed;
}
