import type {
  CompanyDetail,
  CompanyListResponse,
  ContactDealAssociation,
  ContactDetail,
  ContactListResponse,
  ContactListRow,
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

/** GET /contacts/:id/deals → { associations }, each wrapping a deal. Reps see only their own deals. */
export async function getContactDeals(
  fetcher: Fetcher,
  contactId: string,
): Promise<ContactDealAssociation[]> {
  const res = await fetcher<{ associations: ContactDealAssociation[] }>(`/contacts/${contactId}/deals`);
  return res.associations ?? [];
}

/** POST /contacts/:id/assign-to-me → { contact }, the raw row. Returns the raw shape, not ContactDetail. */
export async function assignContactToMe(fetcher: Fetcher, contactId: string): Promise<unknown> {
  return fetcher(`/contacts/${contactId}/assign-to-me`, { method: "POST" });
}

/** GET /companies → the service result directly: { companies, pagination }. */
export async function listCompanies(
  fetcher: Fetcher,
  params: { search?: string; page?: number; limit?: number } = {},
): Promise<CompanyListResponse> {
  const { search, page, limit } = params;
  const res = await fetcher<CompanyListResponse>("/companies", {
    query: {
      search: search?.trim() || undefined,
      page: page && page > 0 ? page : undefined,
      limit,
    },
  });
  return { companies: res.companies ?? [], pagination: res.pagination };
}

/** GET /companies/:id → { company }, already merged with its stats server-side. */
export async function getCompany(fetcher: Fetcher, companyId: string): Promise<CompanyDetail> {
  const res = await fetcher<{ company: CompanyDetail }>(`/companies/${companyId}`);
  return res.company;
}

/** GET /companies/:id/contacts → { contacts }. Same row shape as the contacts list. */
export async function getCompanyContacts(
  fetcher: Fetcher,
  companyId: string,
): Promise<ContactListRow[]> {
  const res = await fetcher<{ contacts: ContactListRow[] }>(`/companies/${companyId}/contacts`);
  return res.contacts ?? [];
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
