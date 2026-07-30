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
  /**
   * BOTH, because the server selects both columns and either can hold the classification. The web
   * detail renders `propertyType ?? type` for exactly this reason; modelling only one silently drops
   * the Type row for every property carrying the other.
   */
  propertyType?: string | null;
  type?: string | null;
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
  /**
   * THE SERVER'S NAMES, not tidier ones.
   *
   * companies/service.ts:197-199 returns `activeDealsCount`, `dealCount` and `contactCount`. I had
   * declared `activeDealCount` / `totalDealCount`, and because the fetcher's generic is an assertion
   * rather than a transform, those simply read `undefined` — so every count badge was omitted and the
   * enclosing condition hid the valid `contactCount` with them. A type that renames a field does not
   * rename it; it just stops seeing it.
   */
  activeDealsCount?: number | null;
  dealCount?: number | null;
  contactCount?: number | null;
};

/**
 * One page. The caller pages until a SHORT page arrives.
 *
 * Deliberately not read off a total: properties answers `{ properties, page, limit, total }` while
 * companies answers a differently-shaped set of aggregates, so "fewer rows than I asked for" is the
 * one end-of-list signal both routes agree on. A fixed single page was silently unreachable past the
 * first fifty in an office that has more.
 */
export async function listProperties(
  fetcher: Fetcher,
  params: { search?: string; page?: number; limit?: number },
): Promise<{ properties: PropertyListItem[] }> {
  const q = new URLSearchParams();
  if (params.search) q.set("search", params.search);
  q.set("page", String(params.page ?? 1));
  q.set("limit", String(params.limit ?? 50));
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
  q.set("page", String(params.page ?? 1));
  q.set("limit", String(params.limit ?? 50));
  const res = await fetcher<{ companies?: CompanyListItem[] }>(`/companies?${q.toString()}`);
  return { companies: res.companies ?? [] };
}

export async function getCompany(fetcher: Fetcher, id: string): Promise<CompanyListItem> {
  const res = await fetcher<{ company: CompanyListItem }>(`/companies/${id}`);
  return res.company;
}
