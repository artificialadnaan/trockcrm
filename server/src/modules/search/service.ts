import { sql, eq, and, or, inArray, gte, asc, desc, type Column, type SQL } from "drizzle-orm";
import crypto from "crypto";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type * as schema from "@trock-crm/shared/schema";
import { aiFeedback, userOfficeAccess, offices, users, deals, contacts, companies, leads, properties, pipelineStageConfig } from "@trock-crm/shared/schema";
import { db, pool } from "../../db.js";
import { drizzle } from "drizzle-orm/node-postgres";
import {
  buildDealSearchCondition,
  buildContactSearchCondition,
  buildCompanySearchCondition,
  buildLeadSearchCondition,
  buildPropertySearchCondition,
  escapeLikePattern,
} from "./unified-search.js";
import { TERMINAL_STAGE_SLUGS } from "../shared/pipeline-terminal-stages.js";
import { capPerOffice, deriveDealStatus, mergeAndLimit, mergeWithOfficeCap, type DealLifecycle } from "./global-search-helpers.js";

type TenantDb = NodePgDatabase<typeof schema>;

export type SearchType = "deals" | "contacts" | "files" | "companies" | "leads" | "properties";

const DEFAULT_SEARCH_TYPES: SearchType[] = ["deals", "contacts", "files", "companies", "leads", "properties"];
const PER_ENTITY_LIMIT = 25;

export interface SearchResult {
  entityType: "deal" | "contact" | "file" | "company" | "lead" | "property";
  id: string;
  primaryLabel: string;
  secondaryLabel: string;
  tertiaryLabel?: string;
  status?: DealLifecycle | null;
  officeSlug?: string;
  deepLink: string;
  rank: number;
  // True when this deal result is a change-order child deal, so the UI can badge it. Deal results only.
  isChangeOrder?: boolean;
}

export interface SearchResponse {
  deals: SearchResult[];
  contacts: SearchResult[];
  files: SearchResult[];
  companies: SearchResult[];
  leads: SearchResult[];
  properties: SearchResult[];
  total: number;
  query: string;
}

export interface AiSearchEvidence {
  id: string;
  sourceType: string;
  sourceId: string;
  dealId: string | null;
  entityType: "deal" | "contact" | "file" | "crm_text";
  entityLabel: string | null;
  title: string;
  snippet: string;
  deepLink: string;
  interactionScore?: number;
}

export interface AiSearchEntityAnchor {
  entityType: "deal" | "contact" | "file";
  id: string;
  label: string;
  deepLink: string;
  interactionScore?: number;
}

export interface AiSearchRecommendedAction {
  actionType:
    | "open_best_match"
    | "review_deal_emails"
    | "open_contact"
    | "open_file_context"
    | "open_deal_context"
    | "open_deal_copilot"
    | "refresh_deal_copilot";
  label: string;
  rationale: string;
  deepLink: string;
  executionMode: "navigate" | "api_then_navigate";
  apiEndpoint?: string;
  apiMethod?: "POST";
  successMessage?: string;
  interactionScore?: number;
}

export interface AiSearchResponse {
  queryId: string;
  query: string;
  intent: "deal_lookup" | "contact_lookup" | "file_lookup" | "account_research" | "activity_lookup" | "general_search";
  summary: string;
  structured: SearchResponse;
  topEntities: AiSearchEntityAnchor[];
  recommendedActions: AiSearchRecommendedAction[];
  evidence: AiSearchEvidence[];
}

const MAX_AI_EVIDENCE = 5;

async function settleSequential<T>(operation: () => Promise<T>): Promise<PromiseSettledResult<T>> {
  try {
    return { status: "fulfilled", value: await operation() };
  } catch (reason) {
    return { status: "rejected", reason };
  }
}

/**
 * Search across deals, contacts, and files using PostgreSQL full-text search.
 * Requires minimum 2-character query (enforced at route level).
 * Results are ranked by ts_rank and returned grouped by entity type.
 *
 * For directors/admins: queries across all accessible office schemas, merges
 * and re-ranks results. For reps: single-office behavior (unchanged).
 */
export async function globalSearch(
  tenantDb: TenantDb,
  query: string,
  types: SearchType[] = DEFAULT_SEARCH_TYPES,
  userRole?: string,
  userId?: string,
): Promise<SearchResponse> {
  // Trim only -- the ILIKE builders escape LIKE metacharacters, so punctuation-bearing terms
  // (deal numbers like D-1001, emails, phones with +, names with & or #) must reach the query
  // literally. (The old full-text path needed the strip; the substring path does not.)
  const sanitized = query.trim();
  if (sanitized.length < 2) {
    return emptyResponse(query);
  }

  // For directors/admins, search across all accessible offices
  if (userId && userRole && (userRole === "admin" || userRole === "director")) {
    return crossOfficeSearch(sanitized, types, userId);
  }

  // Default: single-office search (reps). Office-scoped tenantDb + office-level collaboration
  // read = a rep sees their whole office's records (same as the collaborative detail path).
  return singleOfficeSearch(tenantDb, sanitized, types);
}

function emptyResponse(query: string): SearchResponse {
  return { deals: [], contacts: [], files: [], companies: [], leads: [], properties: [], total: 0, query };
}

export async function naturalLanguageSearch(
  tenantDb: TenantDb,
  query: string,
  types: Array<"deals" | "contacts" | "files"> = ["deals", "contacts", "files"],
  userRole?: string,
  userId?: string,
): Promise<AiSearchResponse> {
  const structured = await globalSearch(tenantDb, query, types, userRole, userId);
  const intent = classifySearchIntent(structured.query);
  const evidence = await searchAiEvidence(tenantDb, structured.query);
  const interactionScores = await getSearchInteractionScores(tenantDb);
  const rankedEvidence = rankEvidenceByInteractions(evidence, interactionScores);
  const rankedTopEntities = buildTopEntityAnchors(structured, interactionScores);
  const rankedActions = buildRecommendedActions(structured, rankedEvidence, interactionScores, intent);

  return {
    queryId: crypto.randomUUID(),
    query: structured.query,
    intent,
    summary: buildAiSearchSummary(structured, rankedEvidence),
    structured,
    topEntities: rankedTopEntities,
    recommendedActions: rankedActions,
    evidence: rankedEvidence,
  };
}

async function runEntitySearches(
  searchDb: TenantDb,
  sanitized: string,
  types: SearchType[],
  limit: number,
): Promise<Record<SearchType, SearchResult[]>> {
  // Sequential on purpose: the cross-office path runs these on a SINGLE pooled pg client (one
  // search_path), which cannot multiplex concurrent queries. settleSequential keeps one failing
  // entity from sinking the rest.
  const runOne = async (include: boolean, fn: () => Promise<SearchResult[]>): Promise<SearchResult[]> => {
    if (!include) return [];
    const settled = await settleSequential(fn);
    return settled.status === "fulfilled" ? settled.value : [];
  };

  const dealHits = await runOne(types.includes("deals"), () => searchDeals(searchDb, sanitized, limit));
  const contactHits = await runOne(types.includes("contacts"), () => searchContacts(searchDb, sanitized, limit));
  const fileHits = await runOne(types.includes("files"), () => searchFiles(searchDb, sanitized, limit));
  const companyHits = await runOne(types.includes("companies"), () => searchCompanies(searchDb, sanitized, limit));
  const leadHits = await runOne(types.includes("leads"), () => searchLeads(searchDb, sanitized, limit));
  const propertyHits = await runOne(types.includes("properties"), () => searchProperties(searchDb, sanitized, limit));

  return { deals: dealHits, contacts: contactHits, files: fileHits, companies: companyHits, leads: leadHits, properties: propertyHits };
}

function assembleResponse(
  query: string,
  groups: Record<SearchType, SearchResult[]>,
  limit: number,
  perOfficeCap?: number,
): SearchResponse {
  // Single office (perOfficeCap undefined) -> plain top-N. Cross-office -> fair cap + backfill so
  // a big office can't monopolize the page yet the page still fills when matches concentrate.
  const merge = (group: SearchResult[]): SearchResult[] =>
    perOfficeCap != null
      ? mergeWithOfficeCap(group, limit, perOfficeCap).hits
      : mergeAndLimit(group, limit).hits;
  const dealHits = merge(groups.deals);
  const contactHits = merge(groups.contacts);
  const fileHits = merge(groups.files);
  const companyHits = merge(groups.companies);
  const leadHits = merge(groups.leads);
  const propertyHits = merge(groups.properties);
  return {
    deals: dealHits,
    contacts: contactHits,
    files: fileHits,
    companies: companyHits,
    leads: leadHits,
    properties: propertyHits,
    total:
      dealHits.length + contactHits.length + fileHits.length +
      companyHits.length + leadHits.length + propertyHits.length,
    query,
  };
}

async function singleOfficeSearch(
  tenantDb: TenantDb,
  sanitized: string,
  types: SearchType[],
): Promise<SearchResponse> {
  // tenantDb is already scoped to the rep's active office; collaboration access grants
  // office-level read, so no per-rep restriction is applied (office scoping is the boundary).
  const groups = await runEntitySearches(tenantDb, sanitized, types, PER_ENTITY_LIMIT);
  return assembleResponse(sanitized, groups, PER_ENTITY_LIMIT);
}

async function crossOfficeSearch(
  sanitized: string,
  types: SearchType[],
  userId: string,
): Promise<SearchResponse> {
  // Include both explicit cross-office access and the user's primary office. (Scope/visibility
  // resolution preserved verbatim -- this PR widens nothing.)
  const [accessRows, userRows] = await Promise.all([
    db
      .select({ officeId: userOfficeAccess.officeId })
      .from(userOfficeAccess)
      .where(eq(userOfficeAccess.userId, userId)),
    db
      .select({ officeId: users.officeId })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1),
  ]);

  const officeIds = new Set(accessRows.map((r) => r.officeId));
  const primaryOfficeId = userRows[0]?.officeId;
  if (primaryOfficeId) {
    officeIds.add(primaryOfficeId);
  }

  const officeRows = await db
    .select({ id: offices.id, slug: offices.slug })
    .from(offices)
    .where(eq(offices.isActive, true));

  const accessibleOffices = officeRows.filter((o) => officeIds.has(o.id));
  if (accessibleOffices.length === 0) {
    return emptyResponse(sanitized);
  }

  // Anti-crowd-out WITH backfill: fetch the FULL per-entity limit from each office (so backfill
  // material exists), then at merge time take a fair per-office slice first and fill the rest from
  // the globally-ranked leftovers. Fetching only the cap per office (the old approach) starved the
  // page whenever matches were concentrated in fewer offices than the cap assumed.
  const perOfficeCap = capPerOffice(PER_ENTITY_LIMIT, accessibleOffices.length);
  const merged: Record<SearchType, SearchResult[]> = {
    deals: [], contacts: [], files: [], companies: [], leads: [], properties: [],
  };

  await Promise.allSettled(
    accessibleOffices.map(async (office) => {
      const client = await pool.connect();
      try {
        const schemaName = `office_${office.slug}`;
        await client.query("SELECT set_config('search_path', $1, false)", [`${schemaName},public`]);
        const officeDb = drizzle(client, { schema: undefined as any });
        const groups = await runEntitySearches(officeDb as any, sanitized, types, PER_ENTITY_LIMIT);
        for (const key of Object.keys(merged) as SearchType[]) {
          merged[key].push(
            ...groups[key].map((item) => ({
              ...item,
              officeSlug: office.slug,
              // Cross-office hit: carry the originating office so the detail fetch targets that
              // office schema (api.ts reads ?officeId -> x-office-id header), not the active one.
              deepLink: appendQuery(item.deepLink, { officeId: office.id }),
            })),
          );
        }
      } finally {
        await client.query("SELECT set_config('search_path', 'public', false)");
        client.release();
      }
    }),
  );

  return assembleResponse(sanitized, merged, PER_ENTITY_LIMIT, perOfficeCap);
}

// Relevance score for ORDER BY: exact match on any column (3) > prefix (2) > other/related (1).
// Applied BEFORE the per-entity LIMIT so a strong older match is never dropped for newer weak ones.
// Accepts raw SQL expressions as well as columns, so a derived match the builder uses (e.g. a
// CONCAT full-name) can be ranked the same as a plain column.
function relevanceOrder(query: string, columns: Array<Column | SQL>): SQL<number> {
  const prefix = `${escapeLikePattern(query.trim())}%`;
  const exact = query.trim().toLowerCase();
  const exactChecks = sql.join(columns.map((c) => sql`lower(coalesce(${c}, '')) = ${exact}`), sql` OR `);
  const prefixChecks = sql.join(columns.map((c) => sql`${c} ILIKE ${prefix} ESCAPE '\\'`), sql` OR `);
  return sql<number>`CASE WHEN ${exactChecks} THEN 3 WHEN ${prefixChecks} THEN 2 ELSE 1 END`;
}

// Append query params safely whether or not the URL already has a query string (so a
// cross-office deepLink carrying ?officeId doesn't collide with later ?tab=... appends).
function appendQuery(url: string, params: Record<string, string>): string {
  const qs = new URLSearchParams(params).toString();
  if (!qs) return url;
  return `${url}${url.includes("?") ? "&" : "?"}${qs}`;
}

async function searchDeals(tenantDb: TenantDb, query: string, limit: number): Promise<SearchResult[]> {
  // Unified substring field set (name/number/project/address/owner/company/contact via the
  // shared builder). The REAL stage slug comes from pipeline_stage_config via stageId -- the
  // denormalized bid-board slug is only set at the estimating boundary, so it would miss
  // CRM-owned Won/Lost. Findable set = active OR a terminal (won/lost) stage: terminal deals are
  // FINDABLE + MARKED, while soft-deleted (inactive, non-terminal) deals stay hidden.
  // ONE relevance score, reused for BOTH the SQL ORDER BY (which rows survive the per-entity LIMIT)
  // and the SearchResult.rank the cross-office merge re-ranks on -- so the merge can never demote or
  // drop a row on a field the SQL ranked it on. (The old JS scoreMatch covered fewer fields than the
  // builder/ORDER BY, so e.g. a zip/state/customer-only match got rank 0 and could be merged out.)
  const relevance = relevanceOrder(query, [deals.name, deals.dealNumber, deals.projectNumber, deals.description, deals.propertyAddress, deals.propertyCity, deals.propertyState, deals.bidBoardCustomerName]);
  const rows = await tenantDb
    .select({
      id: deals.id,
      name: deals.name,
      dealNumber: deals.dealNumber,
      projectNumber: deals.projectNumber,
      propertyCity: deals.propertyCity,
      propertyState: deals.propertyState,
      onHold: deals.onHold,
      isChangeOrder: deals.isChangeOrder,
      stageSlug: pipelineStageConfig.slug,
      relevance,
    })
    .from(deals)
    .leftJoin(pipelineStageConfig, eq(pipelineStageConfig.id, deals.stageId))
    .where(
      and(
        buildDealSearchCondition(query),
        or(eq(deals.isActive, true), inArray(pipelineStageConfig.slug, [...TERMINAL_STAGE_SLUGS])),
        // A soft-deleted change-order child is a (terminal) Won deal, so the terminal-findable rule above
        // would keep it searchable + deep-linkable to a deleted CO. Exclude inactive CO children explicitly.
        sql`NOT (${deals.isChangeOrder} = true AND ${deals.isActive} = false)`,
      ),
    )
    // Status tier FIRST (active < on_hold < terminal) so the per-entity cap can't fill up with
    // recently-updated won/lost deals and starve older active ones; then relevance, then recency.
    // (mergeAndLimit applies the same active-first comparator + rank after merge.)
    .orderBy(
      asc(sql<number>`CASE WHEN ${inArray(pipelineStageConfig.slug, [...TERMINAL_STAGE_SLUGS])} THEN 2 WHEN ${deals.onHold} THEN 1 ELSE 0 END`),
      desc(relevance),
      desc(deals.updatedAt),
    )
    .limit(limit);

  return rows.map((r): SearchResult => ({
    entityType: "deal",
    id: r.id,
    primaryLabel: r.name ?? "Unnamed Deal",
    secondaryLabel: pickDealSecondaryLabel(r.projectNumber, r.dealNumber),
    tertiaryLabel: [r.propertyCity, r.propertyState].filter(Boolean).join(", ") || undefined,
    status: deriveDealStatus(r.stageSlug, r.onHold),
    deepLink: `/deals/${r.id}`,
    rank: Number(r.relevance ?? 0),
    isChangeOrder: r.isChangeOrder === true,
  }));
}

const HUBSPOT_DEAL_NUMBER_PATTERN = /^HS[-_ ]?\d+/i;

export function pickDealSecondaryLabel(projectNumber: string | null, dealNumber: string | null): string {
  const project = projectNumber?.trim();
  if (project) return project;
  const deal = dealNumber?.trim();
  if (deal && !HUBSPOT_DEAL_NUMBER_PATTERN.test(deal)) return deal;
  return "";
}

async function searchContacts(tenantDb: TenantDb, query: string, limit: number): Promise<SearchResult[]> {
  // Relevance over EVERY field the builder matches (name parts/email/company + phone/mobile/jobTitle/
  // city AND the derived full-name CONCAT), reused as the merge rank -- so a phone-fragment, city, or
  // two-word full-name match can't be dropped before the limit nor demoted in the cross-office merge.
  const relevance = relevanceOrder(query, [
    contacts.firstName, contacts.lastName, contacts.email, contacts.companyName,
    contacts.phone, contacts.mobile, contacts.jobTitle, contacts.city,
    sql`(coalesce(${contacts.firstName}, '') || ' ' || coalesce(${contacts.lastName}, ''))`,
  ]);
  const rows = await tenantDb
    .select({
      id: contacts.id,
      firstName: contacts.firstName,
      lastName: contacts.lastName,
      email: contacts.email,
      phone: contacts.phone,
      companyName: contacts.companyName,
      relevance,
    })
    .from(contacts)
    .where(and(buildContactSearchCondition(query), eq(contacts.isActive, true)))
    .orderBy(desc(relevance), desc(contacts.updatedAt))
    .limit(limit);

  return rows.map((r): SearchResult => {
    const name = [r.firstName, r.lastName].filter(Boolean).join(" ") || "Unknown Contact";
    return {
      entityType: "contact",
      id: r.id,
      primaryLabel: name,
      secondaryLabel: r.email ?? r.phone ?? "",
      tertiaryLabel: r.companyName ?? undefined,
      deepLink: `/contacts/${r.id}`,
      rank: Number(r.relevance ?? 0),
    };
  });
}

async function searchCompanies(tenantDb: TenantDb, query: string, limit: number): Promise<SearchResult[]> {
  // Relevance over the SAME own fields the builder matches (name/domain/website/address/city/state),
  // reused as the merge rank, so an exact domain/address/city/state hit isn't pushed out of the limit
  // by weaker name matches nor demoted in the cross-office merge.
  const relevance = relevanceOrder(query, [companies.name, companies.domain, companies.website, companies.address, companies.city, companies.state]);
  const rows = await tenantDb
    .select({
      id: companies.id,
      name: companies.name,
      city: companies.city,
      state: companies.state,
      relevance,
    })
    .from(companies)
    .where(and(buildCompanySearchCondition(query), eq(companies.isActive, true)))
    .orderBy(desc(relevance), desc(companies.updatedAt))
    .limit(limit);

  return rows.map((r): SearchResult => ({
    entityType: "company",
    id: r.id,
    primaryLabel: r.name ?? "Unnamed Account",
    secondaryLabel: [r.city, r.state].filter(Boolean).join(", ") || "",
    deepLink: `/companies/${r.id}`,
    rank: Number(r.relevance ?? 0),
  }));
}

async function searchLeads(tenantDb: TenantDb, query: string, limit: number): Promise<SearchResult[]> {
  // Findable set = active OR a terminal lead state (converted/disqualified). BOTH terminal states
  // set is_active=false -- conversion (leads/conversion-service) sets status='converted', and
  // disqualifying (leads/service updateLead: isActive = status==='open') sets status='disqualified'
  // -- so an is_active-only filter would silently hide every closed lead, including the builder's
  // converted-deal-number match path. Mirrors deals surfacing BOTH won AND lost: terminal leads are
  // findable + MARKED (status shown in the label). Admin soft-delete leaves status='open', so it is
  // never matched here and stays hidden.
  // Relevance over the lead's own matched text columns (not just name), reused as the merge rank, so
  // an exact source/sourceDetail/description hit isn't pushed past the limit nor demoted by weaker name matches.
  const relevance = relevanceOrder(query, [leads.name, leads.source, leads.sourceDetail, leads.description]);
  const rows = await tenantDb
    .select({ id: leads.id, name: leads.name, status: leads.status, relevance })
    .from(leads)
    .where(and(buildLeadSearchCondition(query), or(eq(leads.isActive, true), inArray(leads.status, ["converted", "disqualified"]))))
    .orderBy(desc(relevance), desc(leads.updatedAt))
    .limit(limit);

  return rows.map((r): SearchResult => ({
    entityType: "lead",
    id: r.id,
    primaryLabel: r.name ?? "Unnamed Lead",
    secondaryLabel: r.status ? `Lead · ${r.status}` : "Lead",
    deepLink: `/leads/${r.id}`,
    rank: Number(r.relevance ?? 0),
  }));
}

async function searchProperties(tenantDb: TenantDb, query: string, limit: number): Promise<SearchResult[]> {
  // Relevance over every own field the builder matches (incl. state/zip), reused as the merge rank,
  // so an exact zip/state hit isn't dropped before the limit nor demoted in the cross-office merge
  // (state/zip aren't displayed, so they're scored via the SQL relevance rather than re-fetched).
  const relevance = relevanceOrder(query, [properties.name, properties.address, properties.city, properties.state, properties.zip]);
  const rows = await tenantDb
    .select({
      id: properties.id,
      name: properties.name,
      address: properties.address,
      city: properties.city,
      state: properties.state,
      relevance,
    })
    .from(properties)
    .where(and(buildPropertySearchCondition(query), eq(properties.isActive, true)))
    .orderBy(desc(relevance), desc(properties.updatedAt))
    .limit(limit);

  return rows.map((r): SearchResult => {
    const locality = [r.city, r.state].filter(Boolean).join(", ");
    return {
      entityType: "property",
      id: r.id,
      primaryLabel: r.name || r.address || "Property",
      secondaryLabel: [r.address, locality].filter(Boolean).join(" · ") || "",
      deepLink: `/properties/${r.id}`,
      rank: Number(r.relevance ?? 0),
    };
  });
}

async function searchFiles(tenantDb: TenantDb, query: string, limit: number): Promise<SearchResult[]> {
  const result = await tenantDb.execute(sql`
    SELECT
      f.id,
      f.display_name,
      f.category,
      f.deal_id,
      f.contact_id,
      ts_rank(f.search_vector, plainto_tsquery('english', ${query})) AS rank
    FROM files f
    WHERE f.is_active = true
      AND f.search_vector @@ plainto_tsquery('english', ${query})
    ORDER BY rank DESC
    LIMIT ${limit}
  `);

  const rows = (result as any).rows ?? result;
  return rows.map((r: any): SearchResult => {
    let deepLink = "/files";
    if (r.deal_id) deepLink = `/deals/${r.deal_id}/files`;
    else if (r.contact_id) deepLink = `/contacts/${r.contact_id}`;

    return {
      entityType: "file",
      id: r.id,
      primaryLabel: r.display_name ?? "Unnamed File",
      secondaryLabel: r.category ?? "",
      deepLink,
      rank: Number(r.rank ?? 0),
    };
  });
}

async function searchAiEvidence(tenantDb: TenantDb, query: string): Promise<AiSearchEvidence[]> {
  const sanitized = query.trim().replace(/[^\w\s-]/g, "").trim();
  if (sanitized.length < 2) return [];

  const result = await tenantDb.execute(sql`
    WITH ranked_chunks AS (
      SELECT
        c.id,
        d.source_type,
        d.source_id,
        d.deal_id,
        c.text,
        c.metadata_json,
        ts_rank_cd(
          to_tsvector('english', c.text),
          websearch_to_tsquery('english', ${sanitized})
        ) AS rank
      FROM ai_embedding_chunks c
      JOIN ai_document_index d ON d.id = c.document_id
      WHERE to_tsvector('english', c.text) @@ websearch_to_tsquery('english', ${sanitized})
    )
    SELECT
      id,
      source_type,
      source_id,
      deal_id,
      text,
      metadata_json,
      rank
    FROM ranked_chunks
    ORDER BY rank DESC
    LIMIT ${MAX_AI_EVIDENCE}
  `);

  const rows = (result as any).rows ?? result;
  return rows.map((row: any): AiSearchEvidence => {
    const snippet = String(row.text ?? "").replace(/\s+/g, " ").trim().slice(0, 220);
    const sourceType = String(row.source_type ?? "unknown");
    const sourceId = String(row.source_id ?? "");
    const metadata = row.metadata_json ?? {};
    const dealId = row.deal_id ? String(row.deal_id) : null;

    let title = sourceType.replace(/_/g, " ");
    let deepLink = "/search";

    if (sourceType === "email_message") {
      title = metadata.subject ?? "Email evidence";
      if (dealId) deepLink = `/deals/${dealId}`;
    } else if (sourceType === "activity_note") {
      title = metadata.subject ?? metadata.activityType ?? "Activity note";
      if (dealId) deepLink = `/deals/${dealId}`;
    } else if (sourceType === "estimate_snapshot") {
      title = "Estimate snapshot";
      if (dealId) deepLink = `/deals/${dealId}`;
    }

    return {
      id: String(row.id),
      sourceType,
      sourceId,
      dealId,
      entityType: dealId ? "deal" : "crm_text",
      entityLabel: dealId ? title : null,
      title,
      snippet: snippet.length === 220 ? `${snippet}...` : snippet,
      deepLink,
    };
  });
}

function buildAiSearchSummary(structured: SearchResponse, evidence: AiSearchEvidence[]): string {
  const intent = classifySearchIntent(structured.query);
  if (structured.total === 0 && evidence.length === 0) {
    return `No CRM matches or indexed evidence were found for "${structured.query}".`;
  }

  const parts: string[] = [];
  if (intent !== "general_search") {
    parts.push(`Search intent looks like ${intent.replace(/_/g, " ")}.`);
  }

  if (structured.total > 0) {
    parts.push(
      `Found ${structured.total} structured CRM match${structured.total === 1 ? "" : "es"} across ${[
        structured.deals.length ? `${structured.deals.length} deal${structured.deals.length === 1 ? "" : "s"}` : null,
        structured.contacts.length ? `${structured.contacts.length} contact${structured.contacts.length === 1 ? "" : "s"}` : null,
        structured.files.length ? `${structured.files.length} file${structured.files.length === 1 ? "" : "s"}` : null,
      ].filter(Boolean).join(", ")}.`
    );
  }

  if (evidence.length > 0) {
    parts.push(
      `Top indexed evidence includes ${evidence
        .slice(0, 2)
        .map((item) => `"${item.title}"`)
        .join(" and ")}.`
    );
  }

  const topDeal = structured.deals[0];
  if (topDeal) {
    parts.push(`The strongest structured match is deal "${topDeal.primaryLabel}".`);
  } else if (structured.contacts[0]) {
    parts.push(`The strongest structured match is contact "${structured.contacts[0].primaryLabel}".`);
  } else if (structured.files[0]) {
    parts.push(`The strongest structured match is file "${structured.files[0].primaryLabel}".`);
  }

  return parts.join(" ");
}

function classifySearchIntent(query: string): AiSearchResponse["intent"] {
  const normalized = query.toLowerCase().trim();
  if (!normalized) return "general_search";
  if (/^d[-\s]?\d+/i.test(normalized) || normalized.includes("deal")) return "deal_lookup";
  if (normalized.includes("contact") || normalized.includes("email") || normalized.includes("@")) return "contact_lookup";
  if (normalized.includes("file") || normalized.includes("pdf") || normalized.includes("document") || normalized.includes("attachment")) {
    return "file_lookup";
  }
  if (normalized.includes("company") || normalized.includes("account") || normalized.includes("customer")) return "account_research";
  if (normalized.includes("call") || normalized.includes("activity") || normalized.includes("note") || normalized.includes("meeting")) {
    return "activity_lookup";
  }
  return "general_search";
}

function buildTopEntityAnchors(
  structured: SearchResponse,
  interactionScores: SearchInteractionScores
): AiSearchEntityAnchor[] {
  return [...structured.deals, ...structured.contacts, ...structured.files]
    .map((result, index) => ({
      anchor: {
        // deals/contacts/files arrays only ever carry these three narrow entity types.
        entityType: result.entityType as AiSearchEntityAnchor["entityType"],
        id: result.id,
        label: result.primaryLabel,
        deepLink: result.deepLink,
        interactionScore: scoreDeepLink(result.deepLink, interactionScores),
      } satisfies AiSearchEntityAnchor,
      index,
    }))
    .sort((left, right) =>
      ((right.anchor.interactionScore ?? 0) - (left.anchor.interactionScore ?? 0)) ||
      (left.index - right.index)
    )
    .map(({ anchor }) => anchor)
    .slice(0, 3);
}

function buildRecommendedActions(
  structured: SearchResponse,
  evidence: AiSearchEvidence[],
  interactionScores: SearchInteractionScores,
  currentIntent: AiSearchResponse["intent"]
): AiSearchRecommendedAction[] {
  const actions: Array<{ action: AiSearchRecommendedAction; index: number }> = [];
  const push = (action: AiSearchRecommendedAction) => {
    if (!actions.some((existing) => existing.action.deepLink === action.deepLink && existing.action.label === action.label)) {
      actions.push({ action, index: actions.length });
    }
  };

  const topDeal = structured.deals[0];
  const topContact = structured.contacts[0];
  const topFile = structured.files[0];
  const topEvidenceDeal = evidence.find((item) => item.dealId)?.dealId ?? null;

  if (topDeal) {
    push({
      actionType: "open_deal_copilot",
      label: "Open Deal Copilot",
      rationale: `Jump straight into ${topDeal.primaryLabel} and review the AI copilot context.`,
      deepLink: appendQuery(topDeal.deepLink, { tab: "overview", focus: "copilot" }),
      executionMode: "navigate",
      interactionScore: scoreAction("open_deal_copilot", appendQuery(topDeal.deepLink, { tab: "overview", focus: "copilot" }), interactionScores, currentIntent),
    });
    push({
      actionType: "review_deal_emails",
      label: "Review Deal Emails",
      rationale: `Open the email tab for ${topDeal.primaryLabel} to verify the communications behind this answer.`,
      deepLink: appendQuery(topDeal.deepLink, { tab: "email" }),
      executionMode: "navigate",
      interactionScore: scoreAction("review_deal_emails", appendQuery(topDeal.deepLink, { tab: "email" }), interactionScores, currentIntent),
    });
    push({
      actionType: "refresh_deal_copilot",
      label: "Refresh Deal Copilot",
      rationale: `Queue a fresh AI read on ${topDeal.primaryLabel} before you act on this search result.`,
      deepLink: appendQuery(topDeal.deepLink, { tab: "overview", focus: "copilot" }),
      executionMode: "api_then_navigate",
      apiEndpoint: `/ai/deals/${topDeal.id}/regenerate`,
      apiMethod: "POST",
      successMessage: "Deal copilot refresh queued",
      interactionScore: scoreAction("refresh_deal_copilot", appendQuery(topDeal.deepLink, { tab: "overview", focus: "copilot" }), interactionScores, currentIntent),
    });
    push({
      actionType: "open_best_match",
      label: "Open Best Deal Match",
      rationale: `Jump to ${topDeal.primaryLabel} to inspect the strongest structured deal result.`,
      deepLink: appendQuery(topDeal.deepLink, { tab: "overview" }),
      executionMode: "navigate",
      interactionScore: scoreAction("open_best_match", appendQuery(topDeal.deepLink, { tab: "overview" }), interactionScores, currentIntent),
    });
  }

  if (!topDeal && topEvidenceDeal) {
    push({
      actionType: "open_deal_context",
      label: "Open Deal Context",
      rationale: "The strongest AI evidence points to a specific deal context.",
      deepLink: `/deals/${topEvidenceDeal}?tab=overview`,
      executionMode: "navigate",
      interactionScore: scoreAction("open_deal_context", `/deals/${topEvidenceDeal}?tab=overview`, interactionScores, currentIntent),
    });
    push({
      actionType: "review_deal_emails",
      label: "Review Deal Emails",
      rationale: "Open the deal email context tied to the strongest evidence.",
      deepLink: `/deals/${topEvidenceDeal}?tab=email`,
      executionMode: "navigate",
      interactionScore: scoreAction("review_deal_emails", `/deals/${topEvidenceDeal}?tab=email`, interactionScores, currentIntent),
    });
  }

  if (topContact) {
    push({
      actionType: "open_contact",
      label: "Open Best Contact Match",
      rationale: `Jump to ${topContact.primaryLabel} to review the strongest contact result.`,
      deepLink: topContact.deepLink,
      executionMode: "navigate",
      interactionScore: scoreAction("open_contact", topContact.deepLink, interactionScores, currentIntent),
    });
  }

  if (topFile) {
    push({
      actionType: "open_file_context",
      label: "Open File Context",
      rationale: `Review the file location tied to ${topFile.primaryLabel}.`,
      deepLink: topFile.deepLink,
      executionMode: "navigate",
      interactionScore: scoreAction("open_file_context", topFile.deepLink, interactionScores, currentIntent),
    });
  }

  return actions
    .sort((left, right) =>
      ((right.action.interactionScore ?? 0) - (left.action.interactionScore ?? 0)) ||
      (left.index - right.index)
    )
    .map(({ action }) => action)
    .slice(0, 3);
}

interface SearchInteractionScores {
  deepLinkCounts: Map<string, number>;
  actionCounts: Map<string, number>;
  intentActionCounts: Map<string, Map<string, number>>;
}

async function getSearchInteractionScores(tenantDb: TenantDb): Promise<SearchInteractionScores> {
  const rows = (await tenantDb
    .select({
      targetId: aiFeedback.targetId,
      feedbackValue: aiFeedback.feedbackValue,
      comment: aiFeedback.comment,
    })
    .from(aiFeedback)
    .where(
      and(
        eq(aiFeedback.targetType, "search_query"),
        eq(aiFeedback.feedbackType, "search_interaction"),
        gte(aiFeedback.createdAt, sql`NOW() - INTERVAL '90 days'`)
      )
    )) as Array<{ targetId: string; feedbackValue: string; comment: string | null }>;

  const deepLinkCounts = new Map<string, number>();
  const actionCounts = new Map<string, number>();
  const queryIntentById = new Map<string, string>();
  const intentActionCounts = new Map<string, Map<string, number>>();

  for (const row of rows) {
    if (!row.comment) continue;
    try {
      const parsed = JSON.parse(row.comment) as {
        targetValue?: string;
        deepLink?: string;
        queryContext?: { intent?: string };
      };
      if (row.feedbackValue === "search_impression" && parsed.queryContext?.intent) {
        queryIntentById.set(row.targetId, parsed.queryContext.intent);
        continue;
      }
      const weight = row.feedbackValue === "recommended_action_executed" ? 4 : 1;
      if (parsed.deepLink) {
        deepLinkCounts.set(parsed.deepLink, (deepLinkCounts.get(parsed.deepLink) ?? 0) + weight);
      }
      if (parsed.targetValue) {
        actionCounts.set(parsed.targetValue, (actionCounts.get(parsed.targetValue) ?? 0) + weight);
        const intent = queryIntentById.get(row.targetId);
        if (intent) {
          const byIntent = intentActionCounts.get(intent) ?? new Map<string, number>();
          const intentWeight = row.feedbackValue === "recommended_action_executed" ? 2 : 1;
          byIntent.set(parsed.targetValue, (byIntent.get(parsed.targetValue) ?? 0) + intentWeight);
          intentActionCounts.set(intent, byIntent);
        }
      }
    } catch {
      continue;
    }
  }

  return { deepLinkCounts, actionCounts, intentActionCounts };
}

function scoreDeepLink(deepLink: string, interactionScores: SearchInteractionScores) {
  return interactionScores.deepLinkCounts.get(deepLink) ?? 0;
}

function scoreAction(
  actionType: string,
  deepLink: string,
  interactionScores: SearchInteractionScores,
  currentIntent: AiSearchResponse["intent"]
) {
  return (
    (interactionScores.actionCounts.get(actionType) ?? 0) +
    (interactionScores.deepLinkCounts.get(deepLink) ?? 0) +
    (interactionScores.intentActionCounts.get(currentIntent)?.get(actionType) ?? 0)
  );
}

function rankEvidenceByInteractions(
  evidence: AiSearchEvidence[],
  interactionScores: SearchInteractionScores
): AiSearchEvidence[] {
  return [...evidence]
    .map((item, index) => ({
      item: {
        ...item,
        interactionScore: scoreDeepLink(item.deepLink, interactionScores),
      },
      index,
    }))
    .sort((left, right) =>
      ((right.item.interactionScore ?? 0) - (left.item.interactionScore ?? 0)) ||
      (left.index - right.index)
    )
    .map(({ item }) => item);
}
