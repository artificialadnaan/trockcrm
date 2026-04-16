import crypto from "crypto";

export type EmailAssignmentEntityType = "deal" | "lead" | "property" | "company";
export type EmailAssignmentConfidence = "high" | "medium" | "low";
export type EmailAssignmentMatch =
  | "explicit_deal_number"
  | "prior_thread_assignment"
  | "single_deal"
  | "single_lead"
  | "single_property"
  | "unique_property"
  | "company_only";

export interface EmailAssignmentDealCandidate {
  id: string;
  dealNumber: string;
  name: string;
  companyId?: string | null;
  stageSlug?: string | null;
  stageDisplayOrder?: number | null;
  propertyAddress?: string | null;
  propertyCity?: string | null;
  propertyState?: string | null;
  propertyZip?: string | null;
}

export interface EmailAssignmentLeadCandidate {
  id: string;
  leadNumber: string;
  name: string;
  companyId?: string | null;
  relatedDealId?: string | null;
  stageSlug?: string | null;
  stageDisplayOrder?: number | null;
  propertyAddress?: string | null;
  propertyCity?: string | null;
  propertyState?: string | null;
  propertyZip?: string | null;
}

export interface EmailAssignmentPropertyCandidate {
  id: string;
  companyId?: string | null;
  name?: string | null;
  propertyAddress?: string | null;
  propertyCity?: string | null;
  propertyState?: string | null;
  propertyZip?: string | null;
  relatedDealIds?: string[];
}

export interface EmailAssignmentThreadAssignment {
  assignedEntityType: EmailAssignmentEntityType;
  assignedEntityId: string;
  assignedDealId?: string | null;
}

export interface EmailAssignmentContext {
  subject?: string | null;
  bodyPreview?: string | null;
  bodyHtml?: string | null;
  priorThreadAssignment?: EmailAssignmentThreadAssignment | null;
  contactCompanyId?: string | null;
  dealCandidates: EmailAssignmentDealCandidate[];
  leadCandidates?: EmailAssignmentLeadCandidate[];
  propertyCandidates?: EmailAssignmentPropertyCandidate[];
}

export interface EmailAssignmentResult {
  assignedEntityType: EmailAssignmentEntityType | null;
  assignedEntityId: string | null;
  assignedDealId: string | null;
  confidence: EmailAssignmentConfidence;
  ambiguityReason: string | null;
  matchedBy: EmailAssignmentMatch;
  requiresClassificationTask: boolean;
  candidateDealIds: string[];
}

const DEAL_NUMBER_PATTERN = /\b[A-Z]{2,}-\d{4}-\d{4}\b/g;
const UUID_BYTES = 16;

function stripHtml(html: string): string {
  return html
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeText(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function buildEmailSearchText(context: EmailAssignmentContext): string {
  return normalizeText(
    [context.subject, context.bodyPreview, context.bodyHtml ? stripHtml(context.bodyHtml) : null]
      .filter((part): part is string => Boolean(part && part.trim()))
      .join(" ")
  );
}

function buildEmailRawText(context: EmailAssignmentContext): string {
  return [context.subject, context.bodyPreview, context.bodyHtml ? stripHtml(context.bodyHtml) : null]
    .filter((part): part is string => Boolean(part && part.trim()))
    .join(" ");
}

function buildPropertySignature(candidate: EmailAssignmentDealCandidate): string | null {
  const pieces = [candidate.propertyAddress, candidate.propertyCity, candidate.propertyState, candidate.propertyZip]
    .map((piece) => piece?.trim())
    .filter((piece): piece is string => Boolean(piece));

  if (pieces.length === 0) return null;
  return normalizeText(pieces.join(" "));
}

function buildLeadPropertySignature(candidate: {
  propertyAddress?: string | null;
  propertyCity?: string | null;
  propertyState?: string | null;
  propertyZip?: string | null;
}): string | null {
  const pieces = [candidate.propertyAddress, candidate.propertyCity, candidate.propertyState, candidate.propertyZip]
    .map((piece) => piece?.trim())
    .filter((piece): piece is string => Boolean(piece));

  if (pieces.length === 0) return null;
  return normalizeText(pieces.join(" "));
}

function toDeterministicUuid(seed: string): string {
  const digest = crypto.createHash("sha1").update(seed).digest("hex").slice(0, 32);
  const bytes = digest.match(/.{2}/g)?.map((byte) => Number.parseInt(byte, 16)) ?? [];
  if (bytes.length !== UUID_BYTES) {
    throw new Error("Failed to derive deterministic uuid");
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join("-");
}

export function buildPropertyCandidatesFromDeals(
  dealCandidates: EmailAssignmentDealCandidate[]
): EmailAssignmentPropertyCandidate[] {
  const groups = new Map<string, EmailAssignmentPropertyCandidate>();

  for (const deal of dealCandidates) {
    const signature = buildPropertySignature(deal);
    if (!signature) continue;

    const existing = groups.get(signature);
    if (existing) {
      existing.relatedDealIds = [...(existing.relatedDealIds ?? []), deal.id];
      continue;
    }

    groups.set(signature, {
      id: toDeterministicUuid(`property:${signature}`),
      name: [deal.propertyAddress, deal.propertyCity, deal.propertyState, deal.propertyZip]
        .filter((piece): piece is string => Boolean(piece))
        .join(", "),
      companyId: deal.companyId ?? null,
      propertyAddress: deal.propertyAddress ?? null,
      propertyCity: deal.propertyCity ?? null,
      propertyState: deal.propertyState ?? null,
      propertyZip: deal.propertyZip ?? null,
      relatedDealIds: [deal.id],
    });
  }

  return [...groups.values()];
}

export function buildLeadCandidatesFromDeals(
  dealCandidates: EmailAssignmentDealCandidate[],
  estimatingStageDisplayOrder: number | null
): EmailAssignmentLeadCandidate[] {
  if (estimatingStageDisplayOrder == null) return [];

  const leads = new Map<string, EmailAssignmentLeadCandidate>();

  for (const deal of dealCandidates) {
    if (deal.stageDisplayOrder == null || deal.stageDisplayOrder >= estimatingStageDisplayOrder) continue;

    if (leads.has(deal.id)) continue;

    leads.set(deal.id, {
      id: deal.id,
      leadNumber: deal.dealNumber,
      name: deal.name,
      companyId: deal.companyId ?? null,
      relatedDealId: deal.id,
      stageSlug: deal.stageSlug ?? null,
      stageDisplayOrder: deal.stageDisplayOrder ?? null,
      propertyAddress: deal.propertyAddress ?? null,
      propertyCity: deal.propertyCity ?? null,
      propertyState: deal.propertyState ?? null,
      propertyZip: deal.propertyZip ?? null,
    });
  }

  return [...leads.values()];
}

function uniqueById<T extends { id: string }>(values: T[]): T[] {
  const seen = new Set<string>();
  const output: T[] = [];
  for (const value of values) {
    if (seen.has(value.id)) continue;
    seen.add(value.id);
    output.push(value);
  }
  return output;
}

function findExplicitDealCandidate(
  text: string,
  dealCandidates: EmailAssignmentDealCandidate[]
): EmailAssignmentDealCandidate | null {
  const numbers = [...text.toUpperCase().matchAll(DEAL_NUMBER_PATTERN)].map((match) => match[0]);
  for (const number of numbers) {
    const candidate = dealCandidates.find((deal) => deal.dealNumber.toUpperCase() === number);
    if (candidate) return candidate;
  }
  return null;
}

function findPropertyCandidate(
  text: string,
  propertyCandidates: EmailAssignmentPropertyCandidate[]
): EmailAssignmentPropertyCandidate | null {
  const matches = propertyCandidates.filter((candidate) => {
    const signature = buildLeadPropertySignature(candidate);
    return signature ? text.includes(signature) : false;
  });
  if (matches.length !== 1) return null;

  const [match] = matches;
  const relatedDealCount = match.relatedDealIds?.length ?? 0;
  return relatedDealCount <= 1 ? match : null;
}

function buildAmbiguityReason(candidateCount: number, hasCompany: boolean): string {
  if (candidateCount > 1) return "multiple_deal_candidates";
  if (!hasCompany) return "no_company_context";
  return "company_only_fallback";
}

export function resolveEmailAssignment(context: EmailAssignmentContext): EmailAssignmentResult {
  const candidateDeals = uniqueById(context.dealCandidates ?? []);
  const candidateLeads = uniqueById(context.leadCandidates ?? []);
  const candidateProperties = uniqueById(
    context.propertyCandidates ?? buildPropertyCandidatesFromDeals(candidateDeals)
  );
  const rawText = buildEmailRawText(context);
  const searchText = normalizeText(rawText);
  const hasCompany = Boolean(context.contactCompanyId);

  const explicitCandidate = findExplicitDealCandidate(rawText, candidateDeals);
  if (explicitCandidate) {
    return {
      assignedEntityType: "deal",
      assignedEntityId: explicitCandidate.id,
      assignedDealId: explicitCandidate.id,
      confidence: "high",
      ambiguityReason: null,
      matchedBy: "explicit_deal_number",
      requiresClassificationTask: false,
      candidateDealIds: candidateDeals.map((deal) => deal.id),
    };
  }

  if (context.priorThreadAssignment) {
    return {
      assignedEntityType: context.priorThreadAssignment.assignedEntityType,
      assignedEntityId: context.priorThreadAssignment.assignedEntityId,
      assignedDealId: context.priorThreadAssignment.assignedDealId ?? (
        context.priorThreadAssignment.assignedEntityType === "deal"
          ? context.priorThreadAssignment.assignedEntityId
          : null
      ),
      confidence: "high",
      ambiguityReason: null,
      matchedBy: "prior_thread_assignment",
      requiresClassificationTask: false,
      candidateDealIds: candidateDeals.map((deal) => deal.id),
    };
  }

  if (candidateDeals.length === 1) {
    const [deal] = candidateDeals;
    return {
      assignedEntityType: "deal",
      assignedEntityId: deal.id,
      assignedDealId: deal.id,
      confidence: "high",
      ambiguityReason: null,
      matchedBy: "single_deal",
      requiresClassificationTask: false,
      candidateDealIds: [deal.id],
    };
  }

  if (candidateProperties.length === 1) {
    const [propertyCandidate] = candidateProperties;
    const relatedDealCount = propertyCandidate.relatedDealIds?.length ?? 0;
    if (relatedDealCount > 1) {
      return {
        assignedEntityType: hasCompany ? "company" : null,
        assignedEntityId: hasCompany ? context.contactCompanyId ?? null : null,
        assignedDealId: null,
        confidence: "low",
        ambiguityReason: "ambiguous_property_match",
        matchedBy: "company_only",
        requiresClassificationTask: true,
        candidateDealIds: candidateDeals.map((deal) => deal.id),
      };
    }
    return {
      assignedEntityType: "property",
      assignedEntityId: propertyCandidate.id,
      assignedDealId: propertyCandidate.relatedDealIds?.[0] ?? null,
      confidence: "high",
      ambiguityReason: null,
      matchedBy: "single_property",
      requiresClassificationTask: false,
      candidateDealIds: candidateDeals.map((deal) => deal.id),
    };
  }

  const propertyCandidate = findPropertyCandidate(searchText, candidateProperties);
  if (propertyCandidate) {
    return {
      assignedEntityType: "property",
      assignedEntityId: propertyCandidate.id,
      assignedDealId: propertyCandidate.relatedDealIds?.[0] ?? null,
      confidence: "high",
      ambiguityReason: null,
      matchedBy: "unique_property",
      requiresClassificationTask: false,
      candidateDealIds: candidateDeals.map((deal) => deal.id),
    };
  }

  if (candidateLeads.length === 1) {
    const [lead] = candidateLeads;
    return {
      assignedEntityType: "lead",
      assignedEntityId: lead.id,
      assignedDealId: lead.relatedDealId ?? null,
      confidence: "high",
      ambiguityReason: null,
      matchedBy: "single_lead",
      requiresClassificationTask: false,
      candidateDealIds: candidateDeals.map((deal) => deal.id),
    };
  }

  return {
    assignedEntityType: hasCompany ? "company" : null,
    assignedEntityId: hasCompany ? context.contactCompanyId ?? null : null,
    assignedDealId: null,
    confidence: "low",
    ambiguityReason: buildAmbiguityReason(candidateDeals.length, hasCompany),
    matchedBy: "company_only",
    requiresClassificationTask: true,
    candidateDealIds: candidateDeals.map((deal) => deal.id),
  };
}
