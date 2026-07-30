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
  /**
   * A deal's LIFECYCLE, and the reason a closed deal is in these results at all.
   *
   * The server does not filter won, lost and on-hold deals out of search — it labels them, so they
   * stay findable but never read as live work (`deriveDealStatus`). Dropping the field from this type
   * kept the finding and discarded the labelling: a deal lost last quarter rendered with exactly the
   * same "Deal" badge as one closing this week.
   */
  status?: DealLifecycle;
  /**
   * WHICH OFFICE the record lives in.
   *
   * Search is cross-office for an admin or director with multi-office access, and this is how a
   * result says so. It matters because every other request carries the ACTIVE office's `x-office-id`,
   * so a hit from elsewhere would be fetched from the wrong tenant.
   */
  officeSlug?: string;
};

/**
 * What this app asks the server to search — every type it can OPEN, and nothing else.
 *
 * `files` is the omission that matters. The endpoint searches it by default, so every debounced
 * keystroke ran a full-text query over file content that this screen then threw away, because there is
 * no file viewer here to route a hit at. For a director the waste multiplies: cross-office search runs
 * that query once PER accessible office, per keystroke.
 *
 * Kept beside the response type so adding a bucket to one without the other is visible in a diff.
 */
export const MOBILE_SEARCH_TYPES = ["deals", "contacts", "companies", "leads", "properties"] as const;

/**
 * Won and lost are terminal; on-hold is live but paused. `active` carries no marker because the
 * absence of one already says it — a badge on every row would be noise, not information.
 */
export type DealLifecycle = "active" | "on_hold" | "won" | "lost";

export type SearchResponse = {
  deals: SearchResult[];
  contacts: SearchResult[];
  /** Not requested by this app — see MOBILE_SEARCH_TYPES — so the server sends it back empty. */
  files?: SearchResult[];
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
  const types = MOBILE_SEARCH_TYPES.join(",");
  /**
   * `crossOffice=false` — asked for, not filtered for.
   *
   * For an admin or director the endpoint searches every accessible office and caps each entity bucket
   * AFTER merging them. Dropping the foreign rows on the client is therefore too late: the slots they
   * occupied were already spent, and the active office's remaining matches were truncated server-side
   * and never sent. With enough offices the active one can get no slots at all, and the screen would
   * report "nothing matches here" about records that exist.
   *
   * This app works in one office at a time and has no switcher to follow a foreign hit with, so it says
   * so in the request. `partitionByOffice` stays as a guard — cheap, tested, and the thing that keeps
   * this honest if the parameter is ever dropped or ignored.
   */
  return fetcher<SearchResponse>(
    `/search?q=${encodeURIComponent(q)}&types=${types}&crossOffice=false`,
  );
}
