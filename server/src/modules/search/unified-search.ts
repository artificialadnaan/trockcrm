import { sql, type SQL } from "drizzle-orm";
import { deals, companies, contacts, leads, properties } from "@trock-crm/shared/schema";

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
export function buildDealSearchCondition(search: string, dealsTable: typeof deals = deals): SQL {
  // `dealsTable` lets a caller that aliases the deals table (e.g. the stage-page summary's raw
  // `from deals d`) reuse the EXACT same predicate via `alias(deals, "d")`, so the drill-down header
  // search reconciles with the list. Default is the unaliased `deals` table — existing callers unchanged.
  const searchTerm = `%${escapeLikePattern(search.trim())}%`;
  return sql`(
    ${dealsTable.name} ILIKE ${searchTerm} ESCAPE '\\'
    OR ${dealsTable.dealNumber} ILIKE ${searchTerm} ESCAPE '\\'
    OR ${dealsTable.projectNumber} ILIKE ${searchTerm} ESCAPE '\\'
    OR ${dealsTable.description} ILIKE ${searchTerm} ESCAPE '\\'
    OR ${dealsTable.propertyAddress} ILIKE ${searchTerm} ESCAPE '\\'
    OR ${dealsTable.propertyCity} ILIKE ${searchTerm} ESCAPE '\\'
    OR ${dealsTable.propertyState} ILIKE ${searchTerm} ESCAPE '\\'
    OR ${dealsTable.bidBoardCustomerName} ILIKE ${searchTerm} ESCAPE '\\'
    OR EXISTS (
      SELECT 1
      FROM ${companies}
      WHERE ${companies.id} = ${dealsTable.companyId}
        AND ${companies.name} ILIKE ${searchTerm} ESCAPE '\\'
    )
    OR EXISTS (
      SELECT 1
      FROM ${contacts}
      WHERE ${contacts.id} = ${dealsTable.primaryContactId}
        AND (
          ${contacts.firstName} ILIKE ${searchTerm} ESCAPE '\\'
          OR ${contacts.lastName} ILIKE ${searchTerm} ESCAPE '\\'
          OR CONCAT(${contacts.firstName}, ' ', ${contacts.lastName}) ILIKE ${searchTerm} ESCAPE '\\'
        )
    )
    OR EXISTS (
      SELECT 1
      FROM public.users owner_user
      WHERE owner_user.id = ${dealsTable.assignedRepId}
        AND owner_user.display_name ILIKE ${searchTerm} ESCAPE '\\'
    )
  )`;
}

/**
 * The columns the unified lead search matches (PR2). Superset of the legacy leads search
 * (name, source, source_detail, description, company.name, property name/address/city/state,
 * primary contact first/last); owner (assigned rep) display_name and the converted deal's
 * deal_number/project_number are the intended additions, mirroring the deal field set.
 */
export const LEAD_SEARCH_FIELDS = [
  "leads.name",
  "leads.source",
  "leads.source_detail",
  "leads.description",
  "companies.name",
  "properties.name",
  "properties.address",
  "properties.city",
  "properties.state",
  "contacts.first_name",
  "contacts.last_name",
  "users.display_name",
  "deals.deal_number",
  "deals.project_number",
] as const;

/**
 * Build the WHERE predicate that matches a lead by its own text fields plus its company
 * (account), property (incl. city/state for the cascade), primary contact (customer/POC),
 * owner (assigned rep) name, and -- where the lead has been converted -- the resulting
 * deal's deal/project number (deals.source_lead_id = leads.id, unique).
 *
 * Same contract as buildDealSearchCondition: lifecycle-agnostic (never references
 * status / is_active / office / scope -- the caller keeps those), read-only, widens no
 * visibility. Caller must guard min length (>= 2 chars); the term is trimmed + escaped here.
 */
export function buildLeadSearchCondition(search: string): SQL {
  const searchTerm = `%${escapeLikePattern(search.trim())}%`;
  return sql`(
    ${leads.name} ILIKE ${searchTerm} ESCAPE '\\'
    OR ${leads.source} ILIKE ${searchTerm} ESCAPE '\\'
    OR ${leads.sourceDetail} ILIKE ${searchTerm} ESCAPE '\\'
    OR ${leads.description} ILIKE ${searchTerm} ESCAPE '\\'
    OR EXISTS (
      SELECT 1
      FROM ${companies}
      WHERE ${companies.id} = ${leads.companyId}
        AND ${companies.name} ILIKE ${searchTerm} ESCAPE '\\'
    )
    OR EXISTS (
      SELECT 1
      FROM ${properties}
      WHERE ${properties.id} = ${leads.propertyId}
        AND (
          ${properties.name} ILIKE ${searchTerm} ESCAPE '\\'
          OR ${properties.address} ILIKE ${searchTerm} ESCAPE '\\'
          OR ${properties.city} ILIKE ${searchTerm} ESCAPE '\\'
          OR ${properties.state} ILIKE ${searchTerm} ESCAPE '\\'
        )
    )
    OR EXISTS (
      SELECT 1
      FROM ${contacts}
      WHERE ${contacts.id} = ${leads.primaryContactId}
        AND (
          ${contacts.firstName} ILIKE ${searchTerm} ESCAPE '\\'
          OR ${contacts.lastName} ILIKE ${searchTerm} ESCAPE '\\'
          OR CONCAT(${contacts.firstName}, ' ', ${contacts.lastName}) ILIKE ${searchTerm} ESCAPE '\\'
        )
    )
    OR EXISTS (
      SELECT 1
      FROM public.users owner_user
      WHERE owner_user.id = ${leads.assignedRepId}
        AND owner_user.display_name ILIKE ${searchTerm} ESCAPE '\\'
    )
    OR EXISTS (
      SELECT 1
      FROM ${deals}
      WHERE ${deals.sourceLeadId} = ${leads.id}
        AND (
          ${deals.dealNumber} ILIKE ${searchTerm} ESCAPE '\\'
          OR ${deals.projectNumber} ILIKE ${searchTerm} ESCAPE '\\'
        )
    )
  )`;
}

/**
 * The columns the unified company (account) search matches (PR3). Superset of the legacy
 * companies-list search (name only); address, city, state, domain, website, and the owner's
 * display_name are the intended additions — matching the "accounts, cities, domains" promise.
 */
export const COMPANY_SEARCH_FIELDS = [
  "companies.name",
  "companies.address",
  "companies.city",
  "companies.state",
  "companies.domain",
  "companies.website",
  "users.display_name",
] as const;

/**
 * Build the WHERE predicate that matches a company by its own text fields plus its owner's
 * name. Same contract as the deal/lead builders: lifecycle-agnostic (never references
 * is_active / scope — the caller keeps those), read-only, widens no visibility. The owner
 * match is an EXISTS subquery (not a join) so the SAME condition works in both the list query
 * and the COUNT query, which does not join users. Caller guards min length (>= 2 chars).
 */
export function buildCompanySearchCondition(search: string): SQL {
  const searchTerm = `%${escapeLikePattern(search.trim())}%`;
  return sql`(
    ${companies.name} ILIKE ${searchTerm} ESCAPE '\\'
    OR ${companies.address} ILIKE ${searchTerm} ESCAPE '\\'
    OR ${companies.city} ILIKE ${searchTerm} ESCAPE '\\'
    OR ${companies.state} ILIKE ${searchTerm} ESCAPE '\\'
    OR ${companies.domain} ILIKE ${searchTerm} ESCAPE '\\'
    OR ${companies.website} ILIKE ${searchTerm} ESCAPE '\\'
    OR EXISTS (
      SELECT 1
      FROM public.users owner_user
      WHERE owner_user.id = ${companies.ownerId}
        AND owner_user.display_name ILIKE ${searchTerm} ESCAPE '\\'
    )
  )`;
}

/**
 * The columns the unified contact search matches (PR4). Superset of the legacy contacts-list
 * search (first/last/full name, email, company_name, phone, mobile, job_title); city and the
 * owner's display_name are the intended additions, and metacharacters are now escaped (matched
 * literally) like every other builder.
 */
export const CONTACT_SEARCH_FIELDS = [
  "contacts.first_name",
  "contacts.last_name",
  "contacts.email",
  "contacts.company_name",
  "companies.name",
  "contacts.phone",
  "contacts.mobile",
  "contacts.job_title",
  "contacts.city",
  "users.display_name",
] as const;

/**
 * Build the WHERE predicate that matches a contact by its own text fields (name, email,
 * denormalized company name, phone/mobile, job title, city), the LINKED company's real name, and
 * its owner's name. Same contract as the other builders: lifecycle-agnostic, read-only, widens no
 * visibility. The linked-company and owner matches are EXISTS subqueries (not joins) so the SAME
 * condition works in the list query AND the COUNT query (which join neither companies nor users) —
 * the linked company is aliased so it never collides with a companies join the caller may add.
 * Matching companies.name keeps search consistent with the displayed name (the list shows the linked
 * company's real name, which the free-text company_name column is often null/stale for). Caller
 * guards min length (>= 2 chars).
 */
export function buildContactSearchCondition(search: string): SQL {
  const searchTerm = `%${escapeLikePattern(search.trim())}%`;
  return sql`(
    ${contacts.firstName} ILIKE ${searchTerm} ESCAPE '\\'
    OR ${contacts.lastName} ILIKE ${searchTerm} ESCAPE '\\'
    OR CONCAT(${contacts.firstName}, ' ', ${contacts.lastName}) ILIKE ${searchTerm} ESCAPE '\\'
    OR ${contacts.email} ILIKE ${searchTerm} ESCAPE '\\'
    OR ${contacts.companyName} ILIKE ${searchTerm} ESCAPE '\\'
    OR ${contacts.phone} ILIKE ${searchTerm} ESCAPE '\\'
    OR ${contacts.mobile} ILIKE ${searchTerm} ESCAPE '\\'
    OR ${contacts.jobTitle} ILIKE ${searchTerm} ESCAPE '\\'
    OR ${contacts.city} ILIKE ${searchTerm} ESCAPE '\\'
    OR EXISTS (
      SELECT 1
      FROM companies linked_company
      WHERE linked_company.id = ${contacts.companyId}
        AND linked_company.name ILIKE ${searchTerm} ESCAPE '\\'
    )
    OR EXISTS (
      SELECT 1
      FROM public.users owner_user
      WHERE owner_user.id = ${contacts.ownerId}
        AND owner_user.display_name ILIKE ${searchTerm} ESCAPE '\\'
    )
  )`;
}

/**
 * The columns the unified property search matches (PR5). Properties were not a first-class
 * global-search result before; this makes them findable by their own address fields and by the
 * company (account) that owns them.
 */
export const PROPERTY_SEARCH_FIELDS = [
  "properties.name",
  "properties.address",
  "properties.city",
  "properties.state",
  "properties.zip",
  "companies.name",
] as const;

/**
 * Build the WHERE predicate that matches a property by its own address fields plus the company
 * (account) it belongs to. Same contract as the other builders: lifecycle-agnostic, read-only,
 * widens no visibility. Company match is an EXISTS subquery (not a join). Caller guards min
 * length (>= 2 chars).
 */
export function buildPropertySearchCondition(search: string): SQL {
  const searchTerm = `%${escapeLikePattern(search.trim())}%`;
  return sql`(
    ${properties.name} ILIKE ${searchTerm} ESCAPE '\\'
    OR ${properties.address} ILIKE ${searchTerm} ESCAPE '\\'
    OR ${properties.city} ILIKE ${searchTerm} ESCAPE '\\'
    OR ${properties.state} ILIKE ${searchTerm} ESCAPE '\\'
    OR ${properties.zip} ILIKE ${searchTerm} ESCAPE '\\'
    OR EXISTS (
      SELECT 1
      FROM ${companies}
      WHERE ${companies.id} = ${properties.companyId}
        AND ${companies.name} ILIKE ${searchTerm} ESCAPE '\\'
    )
  )`;
}
