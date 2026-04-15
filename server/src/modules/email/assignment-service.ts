export type EmailAssignmentEntityType = "deal" | "company";
export type EmailAssignmentConfidence = "high" | "medium" | "low";
export type EmailAssignmentMatch =
  | "explicit_deal_number"
  | "prior_thread_assignment"
  | "single_deal"
  | "unique_property"
  | "company_only";

export interface EmailAssignmentDealCandidate {
  id: string;
  dealNumber: string;
  name: string;
  companyId?: string | null;
  propertyAddress?: string | null;
  propertyCity?: string | null;
  propertyState?: string | null;
  propertyZip?: string | null;
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
  dealCandidates: EmailAssignmentDealCandidate[]
): EmailAssignmentDealCandidate | null {
  const matches = dealCandidates.filter((candidate) => {
    const signature = buildPropertySignature(candidate);
    return signature ? text.includes(signature) : false;
  });
  return matches.length === 1 ? matches[0] : null;
}

function buildAmbiguityReason(candidateCount: number, hasCompany: boolean): string {
  if (candidateCount > 1) return "multiple_deal_candidates";
  if (!hasCompany) return "no_company_context";
  return "company_only_fallback";
}

export function resolveEmailAssignment(context: EmailAssignmentContext): EmailAssignmentResult {
  const candidateDeals = uniqueById(context.dealCandidates ?? []);
  const rawText = buildEmailRawText(context);
  const searchText = normalizeText(rawText);

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

  const propertyCandidate = findPropertyCandidate(searchText, candidateDeals);
  if (propertyCandidate) {
    return {
      assignedEntityType: "deal",
      assignedEntityId: propertyCandidate.id,
      assignedDealId: propertyCandidate.id,
      confidence: "high",
      ambiguityReason: null,
      matchedBy: "unique_property",
      requiresClassificationTask: false,
      candidateDealIds: candidateDeals.map((deal) => deal.id),
    };
  }

  const hasCompany = Boolean(context.contactCompanyId);
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
