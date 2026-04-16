// server/src/modules/migration/field-mapper.ts

import type {
  HubSpotDeal,
  HubSpotContact,
  HubSpotActivity,
  HubSpotOwner,
  HubSpotCompany,
} from "./hubspot-client.js";

// ---------------------------------------------------------------------------
// Owner ID -> email resolution map
// ---------------------------------------------------------------------------

export function buildOwnerEmailMap(owners: HubSpotOwner[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const owner of owners) {
    if (owner.id && owner.email) {
      map.set(owner.id, owner.email.toLowerCase().trim());
    }
  }
  return map;
}

// ---------------------------------------------------------------------------
// HubSpot deal stage ID -> CRM pipeline stage slug
// Keys are HubSpot dealstage internal values (pipeline-specific IDs or slugs).
// Unknown stage IDs are passed through as-is so validation can flag them.
// ---------------------------------------------------------------------------

const HUBSPOT_STAGE_MAP: Record<string, string> = {
  "appointmentscheduled": "dd",
  "qualifiedtobuy": "dd",
  "presentationscheduled": "estimating",
  "decisionmakerboughtin": "estimating",
  "contractsent": "bid_sent",
  "closedwon": "closed_won",
  "closedlost": "closed_lost",
};

export function mapHubSpotStage(hubspotStage: string | undefined): string {
  if (!hubspotStage) return "";
  const normalized = hubspotStage.toLowerCase().trim();
  return HUBSPOT_STAGE_MAP[normalized] ?? hubspotStage;
}

// ---------------------------------------------------------------------------
// Contact category inference
// ---------------------------------------------------------------------------

function inferContactCategory(contact: HubSpotContact): string {
  const lifecycle = contact.properties.lifecyclestage?.toLowerCase() ?? "";
  const leadStatus = contact.properties.hs_lead_status?.toLowerCase() ?? "";

  if (lifecycle === "customer" || leadStatus === "connected") return "client";
  if (lifecycle === "subscriber" || lifecycle === "lead") return "other";
  return "other";
}

// ---------------------------------------------------------------------------
// Deal mapper
// ---------------------------------------------------------------------------

export interface MappedDeal {
  hubspotDealId: string;
  rawData: Record<string, unknown>;
  mappedName: string | null;
  mappedStage: string | null;
  mappedRepEmail: string | null;
  mappedAmount: number | null;
  mappedCloseDate: string | null;
  mappedSource: string | null;
}

export function mapDeal(
  deal: HubSpotDeal,
  ownerEmailMap: Map<string, string>
): MappedDeal {
  const p = deal.properties;

  let mappedAmount: number | null = null;
  if (p.amount) {
    const parsed = parseFloat(p.amount);
    if (!isNaN(parsed)) mappedAmount = parsed;
  }

  let mappedCloseDate: string | null = null;
  if (p.closedate) {
    const d = new Date(p.closedate);
    if (!isNaN(d.getTime())) {
      mappedCloseDate = d.toISOString().split("T")[0];
    }
  }

  const mappedRepEmail = p.hubspot_owner_id
    ? (ownerEmailMap.get(p.hubspot_owner_id) ?? null)
    : null;

  return {
    hubspotDealId: deal.id,
    rawData: deal as unknown as Record<string, unknown>,
    mappedName: p.dealname?.trim() || null,
    mappedStage: mapHubSpotStage(p.dealstage),
    mappedRepEmail,
    mappedAmount,
    mappedCloseDate,
    mappedSource: p.lead_source?.trim() || "HubSpot",
  };
}

// ---------------------------------------------------------------------------
// Contact mapper
// ---------------------------------------------------------------------------

export interface MappedContact {
  hubspotContactId: string;
  rawData: Record<string, unknown>;
  mappedFirstName: string | null;
  mappedLastName: string | null;
  mappedEmail: string | null;
  mappedPhone: string | null;
  mappedCompany: string | null;
  mappedCategory: string;
}

export interface MappedCompany {
  hubspotCompanyId: string;
  rawData: Record<string, unknown>;
  mappedName: string | null;
  mappedDomain: string | null;
  mappedPhone: string | null;
  mappedOwnerEmail: string | null;
  mappedLeadHint: string | null;
}

export function mapContact(contact: HubSpotContact): MappedContact {
  const p = contact.properties;
  return {
    hubspotContactId: contact.id,
    rawData: contact as unknown as Record<string, unknown>,
    mappedFirstName: p.firstname?.trim() || null,
    mappedLastName: p.lastname?.trim() || null,
    mappedEmail: p.email ? p.email.toLowerCase().trim() : null,
    mappedPhone: p.phone?.replace(/[^\d\-()+\s]/g, "").trim() || null,
    mappedCompany: p.company?.trim() || null,
    mappedCategory: inferContactCategory(contact),
  };
}

export function mapCompany(
  company: HubSpotCompany,
  ownerEmailMap: Map<string, string>
): MappedCompany {
  const p = company.properties;
  const mappedOwnerEmail = p.hubspot_owner_id
    ? (ownerEmailMap.get(p.hubspot_owner_id) ?? null)
    : null;

  return {
    hubspotCompanyId: company.id,
    rawData: company as unknown as Record<string, unknown>,
    mappedName: p.name?.trim() || null,
    mappedDomain: p.domain?.toLowerCase().trim() || null,
    mappedPhone: p.phone?.replace(/[^\d\-()+\s]/g, "").trim() || null,
    mappedOwnerEmail,
    mappedLeadHint: null,
  };
}

// ---------------------------------------------------------------------------
// Activity mapper
// ---------------------------------------------------------------------------

export interface MappedActivity {
  hubspotActivityId: string;
  hubspotDealId: string | null;
  hubspotDealIds: string[];
  hubspotContactId: string | null;
  hubspotContactIds: string[];
  rawData: Record<string, unknown>;
  mappedType: "call" | "note" | "meeting" | "email" | "task_completed" | null;
  mappedSubject: string | null;
  mappedBody: string | null;
  mappedOccurredAt: string | null;
}

function mapActivityType(
  engagementType: string
): "call" | "note" | "meeting" | "email" | "task_completed" | null {
  const t = engagementType.toLowerCase();
  if (t === "calls") return "call";
  if (t === "notes") return "note";
  if (t === "meetings") return "meeting";
  if (t === "emails") return "email";
  if (t === "tasks") return "task_completed";
  return null;
}

export function mapActivity(activity: HubSpotActivity): MappedActivity {
  const p = activity.properties;
  const engType = (activity as any).__type ?? "";

  const hubspotDealIds = Array.from(
    new Set((activity.associations?.deals?.results ?? []).map((assoc) => assoc.id).filter(Boolean))
  );
  const hubspotContactIds = Array.from(
    new Set((activity.associations?.contacts?.results ?? []).map((assoc) => assoc.id).filter(Boolean))
  );
  const hubspotDealId = hubspotDealIds[0] ?? null;
  const hubspotContactId = hubspotContactIds[0] ?? null;

  let subject: string | null = null;
  if (engType === "calls") subject = p.hs_call_title ?? "Call";
  else if (engType === "notes") subject = "Note";
  else if (engType === "meetings") subject = p.hs_meeting_title ?? "Meeting";
  else if (engType === "emails") subject = p.hs_email_subject ?? "Email";

  let body: string | null = null;
  if (engType === "calls") body = p.hs_call_body ?? null;
  else if (engType === "notes") body = p.hs_note_body ?? null;
  else if (engType === "meetings") body = p.hs_meeting_body ?? null;
  else if (engType === "emails") body = p.hs_email_text ?? null;

  let mappedOccurredAt: string | null = null;
  if (p.hs_timestamp) {
    const d = new Date(p.hs_timestamp);
    if (!isNaN(d.getTime())) mappedOccurredAt = d.toISOString();
  }

  return {
    hubspotActivityId: activity.id,
    hubspotDealId,
    hubspotDealIds,
    hubspotContactId,
    hubspotContactIds,
    rawData: activity as unknown as Record<string, unknown>,
    mappedType: mapActivityType(engType),
    mappedSubject: subject,
    mappedBody: body,
    mappedOccurredAt,
  };
}
