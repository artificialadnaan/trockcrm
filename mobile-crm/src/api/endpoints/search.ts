import type { Fetcher } from "./auth";

/**
 * Global search — one box for the whole CRM.
 *
 * Every list in this app searches its own tab, so finding a contact means first guessing which tab
 * they are in. The web has had a unified search since before this app existed; on a phone, where there
 * is no sidebar to scan, it matters more rather than less.
 *
 * ONE UNIFORM SHAPE ACROSS SIX TYPES. `SearchResult` is the same for a deal, a contact, a file, a
 * company, a lead and a property — `primaryLabel` / `secondaryLabel` / `tertiaryLabel` plus an
 * `entityType`. So the phone renders one list rather than six, and the server decides what a row says.
 *
 * `deepLink` is deliberately NOT used for navigation: it is a WEB path ("/deals/:id"), and following
 * it here would send a rep to a route this app does not have. The `entityType` is the routable fact.
 */

export type SearchEntityType = "deal" | "contact" | "file" | "company" | "lead" | "property";

export type SearchResult = {
  entityType: SearchEntityType;
  id: string;
  primaryLabel: string;
  secondaryLabel: string;
  tertiaryLabel?: string;
  rank: number;
  isChangeOrder?: boolean;
};

export type SearchResponse = {
  deals: SearchResult[];
  contacts: SearchResult[];
  files: SearchResult[];
  companies: SearchResult[];
  leads: SearchResult[];
  properties: SearchResult[];
  total: number;
  query: string;
};

/**
 * The server answers a two-character floor with empty buckets and a 200, which is the same floor
 * `search-query.ts` already enforces on every list in this app. Aligned rather than coincidental:
 * the client stops short of asking, and the server stops short of answering.
 */
export async function globalSearch(fetcher: Fetcher, q: string): Promise<SearchResponse> {
  return fetcher<SearchResponse>(`/search?q=${encodeURIComponent(q)}`);
}
