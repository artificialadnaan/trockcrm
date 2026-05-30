import { sql, type SQL } from "drizzle-orm";
import { deals, companies, contacts } from "@trock-crm/shared/schema";

/**
 * Unified search backend (PR1: Deals — the proving ground).
 *
 * Companion to .audit/unified-search-design.md. This module is the single source of
 * truth for "which text fields make an entity match a search term", so list pages and
 * (later) the global header cannot drift apart. PR1 ships the deal field set + builder;
 * the other entity builders and the unifiedSearch composer land in later per-surface PRs.
 *
 * Match semantics (locked): ILIKE '%term%' substring everywhere (not full-text, not
 * prefix), with LIKE metacharacters in the user's term escaped so they match literally.
 */

/**
 * The columns the unified deal search matches, for documentation + the field-map test.
 * Superset of the legacy deals-list search (name, deal_number, description,
 * property_address, company.name); the rest are the intended additions.
 */
export const DEAL_SEARCH_FIELDS = [
  "deals.name",
  "deals.deal_number",
  "deals.project_number",
  "deals.description",
  "deals.property_address",
  "deals.property_city",
  "deals.property_state",
  "deals.bid_board_customer_name",
  "companies.name",
  "contacts.first_name",
  "contacts.last_name",
  "users.display_name",
] as const;

/**
 * Escape LIKE metacharacters (`\`, `%`, `_`) so a term the user types is matched
 * literally inside the `'%' || term || '%'` wrapper, paired with `ESCAPE '\'`.
 */
export function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, "\\$&");
}

/**
 * Build the WHERE predicate that matches a deal by its own text fields plus its
 * company (account), primary contact (customer), and owner (assigned rep) names.
 *
 * Deliberately lifecycle-agnostic: it never references is_active / on_hold / stage, so
 * terminal (won/lost) and on-hold deals are findable — the caller's existing isActive
 * filter still decides what the surface shows. Read-only display: this touches no
 * Won/closed aggregate and widens no office/visibility scope (callers AND their own
 * office + scope predicates on top).
 *
 * Caller must guard min length (>= 2 chars); the term is trimmed + escaped here.
 */
export function buildDealSearchCondition(search: string): SQL {
  const searchTerm = `%${escapeLikePattern(search.trim())}%`;
  return sql`(
    ${deals.name} ILIKE ${searchTerm} ESCAPE '\\'
    OR ${deals.dealNumber} ILIKE ${searchTerm} ESCAPE '\\'
    OR ${deals.projectNumber} ILIKE ${searchTerm} ESCAPE '\\'
    OR ${deals.description} ILIKE ${searchTerm} ESCAPE '\\'
    OR ${deals.propertyAddress} ILIKE ${searchTerm} ESCAPE '\\'
    OR ${deals.propertyCity} ILIKE ${searchTerm} ESCAPE '\\'
    OR ${deals.propertyState} ILIKE ${searchTerm} ESCAPE '\\'
    OR ${deals.bidBoardCustomerName} ILIKE ${searchTerm} ESCAPE '\\'
    OR EXISTS (
      SELECT 1
      FROM ${companies}
      WHERE ${companies.id} = ${deals.companyId}
        AND ${companies.name} ILIKE ${searchTerm} ESCAPE '\\'
    )
    OR EXISTS (
      SELECT 1
      FROM ${contacts}
      WHERE ${contacts.id} = ${deals.primaryContactId}
        AND (
          ${contacts.firstName} ILIKE ${searchTerm} ESCAPE '\\'
          OR ${contacts.lastName} ILIKE ${searchTerm} ESCAPE '\\'
          OR CONCAT(${contacts.firstName}, ' ', ${contacts.lastName}) ILIKE ${searchTerm} ESCAPE '\\'
        )
    )
    OR EXISTS (
      SELECT 1
      FROM public.users owner_user
      WHERE owner_user.id = ${deals.assignedRepId}
        AND owner_user.display_name ILIKE ${searchTerm} ESCAPE '\\'
    )
  )`;
}
