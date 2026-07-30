import type { Fetcher } from "./auth";

/**
 * Properties and companies — the two directory surfaces the web has and this app did not.
 *
 * PROPERTIES closes a hole the app made for itself: field prospecting CREATES properties, matches
 * against them and attaches every visit to one, and there was no way to look one up afterwards. The
 * capture screen's whole subject was unreachable from the rest of the app.
 *
 * COMPANIES closes a claim rather than a hole. `auth/surfaces.ts` has listed `companies` as a granted
 * surface since it was written, so `accessibleSurfaces()` returned a destination that did not exist.
 *
 * ENVELOPES ARE PER-ROUTE HERE and are read off the server, not assumed: the list routes answer the
 * service result directly (`{ properties }`, `{ companies }`), company detail answers
 * `{ company }` with stats folded in, and its sub-resources answer `{ contacts }` and `{ deals }`.
 */

export type PropertyListItem = {
  id: string;
  name: string;
  companyId: string | null;
  companyName: string | null;
  address: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
  propertyType?: string | null;
  buildYear: number | null;
  unitCount: number | null;
  /** Written by field prospecting since #977; null on everything created before it. */
  lat?: number | null;
  lng?: number | null;
  notes?: string | null;
};

export type CompanyListItem = {
  id: string;
  name: string;
  category?: string | null;
  industry?: string | null;
  city?: string | null;
  state?: string | null;
  phone?: string | null;
  website?: string | null;
  /** Server-side counts, so a card never has to fetch its own badges. */
  activeDealCount?: number | null;
  totalDealCount?: number | null;
  contactCount?: number | null;
};

export async function listProperties(
  fetcher: Fetcher,
  params: { search?: string; page?: number; limit?: number },
): Promise<{ properties: PropertyListItem[] }> {
  const q = new URLSearchParams();
  if (params.search) q.set("search", params.search);
  if (params.page) q.set("page", String(params.page));
  if (params.limit) q.set("limit", String(params.limit));
  const res = await fetcher<{ properties?: PropertyListItem[] }>(`/properties?${q.toString()}`);
  // `?? []` because an empty directory answers without the key rather than with an empty array.
  return { properties: res.properties ?? [] };
}

export async function getProperty(fetcher: Fetcher, id: string): Promise<PropertyListItem> {
  const res = await fetcher<{ property: PropertyListItem }>(`/properties/${id}`);
  return res.property;
}

export async function listCompanies(
  fetcher: Fetcher,
  params: { search?: string; page?: number; limit?: number },
): Promise<{ companies: CompanyListItem[] }> {
  const q = new URLSearchParams();
  if (params.search) q.set("search", params.search);
  if (params.page) q.set("page", String(params.page));
  if (params.limit) q.set("limit", String(params.limit));
  const res = await fetcher<{ companies?: CompanyListItem[] }>(`/companies?${q.toString()}`);
  return { companies: res.companies ?? [] };
}

export async function getCompany(fetcher: Fetcher, id: string): Promise<CompanyListItem> {
  const res = await fetcher<{ company: CompanyListItem }>(`/companies/${id}`);
  return res.company;
}
