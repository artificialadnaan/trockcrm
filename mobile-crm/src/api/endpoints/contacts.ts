import type {
  ContactDealAssociation,
  ContactDetail,
  ContactListResponse,
} from "../types";
import type { Fetcher } from "./auth";

/**
 * Contacts and companies.
 *
 * The envelopes here are inconsistent in ways that are invisible to TypeScript, so each one is unwrapped
 * at this boundary with the server's actual `res.json(...)` shape named in a comment. A wrong guess in
 * this file renders an empty list rather than throwing — the silent kind of wrong that reaches TestFlight.
 */

export type ListContactsParams = {
  search?: string;
  companyId?: string;
  page?: number;
  limit?: number;
};

/** GET /contacts → the service result directly: { contacts, pagination }. NOT wrapped again. */
export async function listContacts(
  fetcher: Fetcher,
  params: ListContactsParams = {},
): Promise<ContactListResponse> {
  const { search, companyId, page, limit } = params;
  const res = await fetcher<ContactListResponse>("/contacts", {
    query: {
      search: search?.trim() || undefined,
      companyId,
      // buildQuery keeps 0, and page 0 is not a valid page.
      page: page && page > 0 ? page : undefined,
      limit,
    },
  });
  return { contacts: res.contacts ?? [], pagination: res.pagination };
}

/** GET /contacts/:id → { contact }. This shape carries NO owner fields; see ContactDetail. */
export async function getContact(fetcher: Fetcher, contactId: string): Promise<ContactDetail> {
  const res = await fetcher<{ contact: ContactDetail }>(`/contacts/${contactId}`);
  return res.contact;
}

/**
 * GET /contacts/:id/deals → { associations }, each wrapping a deal. Reps see only their own deals.
 *
 * SOFT-DELETED DEALS ARE DROPPED HERE. contacts/association-service.ts:26-34 joins tenant.deals with no
 * `is_active` predicate — the only read path in the app that does not — so a deleted deal keeps its
 * association row and comes back looking live. Every other surface treats `is_active = false` as deleted
 * and hides it, and a row that opens a detail screen for a deal that no longer exists is worse than an
 * absent row. Filtering at this boundary keeps the rule in one place rather than in each screen.
 */
export async function getContactDeals(
  fetcher: Fetcher,
  contactId: string,
): Promise<ContactDealAssociation[]> {
  const res = await fetcher<{ associations: ContactDealAssociation[] }>(`/contacts/${contactId}/deals`);
  // `isActive !== false` rather than `=== true`: an older row that predates the column, or a redaction
  // that omits it, should stay VISIBLE. Only an explicit false means deleted.
  return (res.associations ?? []).filter((a) => a.deal && a.deal.isActive !== false);
}

/** POST /contacts/:id/assign-to-me → { contact }, the raw row. Returns the raw shape, not ContactDetail. */
export async function assignContactToMe(fetcher: Fetcher, contactId: string): Promise<unknown> {
  return fetcher(`/contacts/${contactId}/assign-to-me`, { method: "POST" });
}

/**
 * The company name to display for a contact.
 *
 * `linkedCompanyName` is joined from the companies table; `companyName` is free text that is null or
 * stale on imported contacts. The web list, the detail header and the company FILTER all coalesce in
 * this order — diverging here would break "filter by what you can see".
 */
export function contactCompanyName(contact: {
  linkedCompanyName?: string | null;
  companyName?: string | null;
}): string | null {
  return contact.linkedCompanyName ?? contact.companyName ?? null;
}

/** Best number to dial. Mobile first — it is the one that reaches a person standing on a roof. */
export function contactPhone(contact: { mobile?: string | null; phone?: string | null }): string | null {
  return contact.mobile ?? contact.phone ?? null;
}


/** snake_case enum tokens are not display text. */
export const CONTACT_CATEGORY_LABELS: Record<string, string> = {
  client: "Client",
  subcontractor: "Subcontractor",
  architect: "Architect",
  property_manager: "Property manager",
  regional_manager: "Regional manager",
  vendor: "Vendor",
  consultant: "Consultant",
  influencer: "Influencer",
  other: "Other",
};

/** Falls back to the raw token rather than hiding an unknown value — a new server enum stays visible. */
export function categoryLabel(category: string | null | undefined): string {
  if (!category) return "";
  return CONTACT_CATEGORY_LABELS[category] ?? category;
}
