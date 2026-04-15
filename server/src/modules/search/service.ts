import { sql, eq } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type * as schema from "@trock-crm/shared/schema";
import { userOfficeAccess, offices, users } from "@trock-crm/shared/schema";
import { db, pool } from "../../db.js";
import { drizzle } from "drizzle-orm/node-postgres";

type TenantDb = NodePgDatabase<typeof schema>;

export interface SearchResult {
  entityType: "deal" | "contact" | "file";
  id: string;
  primaryLabel: string;
  secondaryLabel: string;
  tertiaryLabel?: string;
  officeSlug?: string;
  deepLink: string;
  rank: number;
}

export interface SearchResponse {
  deals: SearchResult[];
  contacts: SearchResult[];
  files: SearchResult[];
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
}

export interface AiSearchEntityAnchor {
  entityType: "deal" | "contact" | "file";
  id: string;
  label: string;
  deepLink: string;
}

export interface AiSearchResponse {
  query: string;
  intent: "deal_lookup" | "contact_lookup" | "file_lookup" | "account_research" | "activity_lookup" | "general_search";
  summary: string;
  structured: SearchResponse;
  topEntities: AiSearchEntityAnchor[];
  evidence: AiSearchEvidence[];
}

const MAX_RESULTS_PER_TYPE = 5;
const MAX_AI_EVIDENCE = 5;

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
  types: Array<"deals" | "contacts" | "files"> = ["deals", "contacts", "files"],
  userRole?: string,
  userId?: string,
): Promise<SearchResponse> {
  const sanitized = query.trim().replace(/[^\w\s-]/g, "").trim();
  if (sanitized.length < 2) {
    return { deals: [], contacts: [], files: [], total: 0, query };
  }

  // For directors/admins, search across all accessible offices
  if (userId && userRole && (userRole === "admin" || userRole === "director")) {
    return crossOfficeSearch(sanitized, types, userId);
  }

  // Default: single-office search (reps)
  return singleOfficeSearch(tenantDb, sanitized, types);
}

export async function naturalLanguageSearch(
  tenantDb: TenantDb,
  query: string,
  types: Array<"deals" | "contacts" | "files"> = ["deals", "contacts", "files"],
  userRole?: string,
  userId?: string,
): Promise<AiSearchResponse> {
  const structured = await globalSearch(tenantDb, query, types, userRole, userId);
  const evidence = await searchAiEvidence(tenantDb, structured.query);

  return {
    query: structured.query,
    intent: classifySearchIntent(structured.query),
    summary: buildAiSearchSummary(structured, evidence),
    structured,
    topEntities: buildTopEntityAnchors(structured),
    evidence,
  };
}

async function singleOfficeSearch(
  tenantDb: TenantDb,
  sanitized: string,
  types: Array<"deals" | "contacts" | "files">,
): Promise<SearchResponse> {
  const results = await Promise.allSettled([
    types.includes("deals") ? searchDeals(tenantDb, sanitized) : Promise.resolve([]),
    types.includes("contacts") ? searchContacts(tenantDb, sanitized) : Promise.resolve([]),
    types.includes("files") ? searchFiles(tenantDb, sanitized) : Promise.resolve([]),
  ]);

  const deals = results[0].status === "fulfilled" ? results[0].value : [];
  const contacts = results[1].status === "fulfilled" ? results[1].value : [];
  const files = results[2].status === "fulfilled" ? results[2].value : [];

  return {
    deals,
    contacts,
    files,
    total: deals.length + contacts.length + files.length,
    query: sanitized,
  };
}

async function crossOfficeSearch(
  sanitized: string,
  types: Array<"deals" | "contacts" | "files">,
  userId: string,
): Promise<SearchResponse> {
  // Include both explicit cross-office access and the user's primary office.
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

  const accessibleOffices = officeRows.filter(
    (o) => officeIds.has(o.id)
  );

  // If no accessible offices, return empty
  if (accessibleOffices.length === 0) {
    return { deals: [], contacts: [], files: [], total: 0, query: sanitized };
  }

  // Search each office schema in parallel
  const allDeals: SearchResult[] = [];
  const allContacts: SearchResult[] = [];
  const allFiles: SearchResult[] = [];

  const searchPromises = accessibleOffices.map(async (office) => {
    const client = await pool.connect();
    try {
      const schemaName = `office_${office.slug}`;
      await client.query("SELECT set_config('search_path', $1, false)", [`${schemaName},public`]);
      const officeDb = drizzle(client, { schema: undefined as any });

      const results = await Promise.allSettled([
        types.includes("deals") ? searchDeals(officeDb as any, sanitized) : Promise.resolve([]),
        types.includes("contacts") ? searchContacts(officeDb as any, sanitized) : Promise.resolve([]),
        types.includes("files") ? searchFiles(officeDb as any, sanitized) : Promise.resolve([]),
      ]);

      const tag = (items: SearchResult[]) =>
        items.map((item) => ({ ...item, officeSlug: office.slug }));

      if (results[0].status === "fulfilled") allDeals.push(...tag(results[0].value));
      if (results[1].status === "fulfilled") allContacts.push(...tag(results[1].value));
      if (results[2].status === "fulfilled") allFiles.push(...tag(results[2].value));
    } finally {
      await client.query("SELECT set_config('search_path', 'public', false)");
      client.release();
    }
  });

  await Promise.allSettled(searchPromises);

  // Re-rank: sort by rank descending, take top N
  const sortAndLimit = (items: SearchResult[]) =>
    items.sort((a, b) => b.rank - a.rank).slice(0, MAX_RESULTS_PER_TYPE);

  const deals = sortAndLimit(allDeals);
  const contacts = sortAndLimit(allContacts);
  const files = sortAndLimit(allFiles);

  return {
    deals,
    contacts,
    files,
    total: deals.length + contacts.length + files.length,
    query: sanitized,
  };
}

async function searchDeals(tenantDb: TenantDb, query: string): Promise<SearchResult[]> {
  const result = await tenantDb.execute(sql`
    SELECT
      d.id,
      d.deal_number,
      d.name,
      d.property_address,
      d.property_city,
      d.property_state,
      ts_rank(
        to_tsvector('english',
          COALESCE(d.deal_number, '') || ' ' ||
          COALESCE(d.name, '') || ' ' ||
          COALESCE(d.description, '') || ' ' ||
          COALESCE(d.property_address, '')
        ),
        plainto_tsquery('english', ${query})
      ) AS rank
    FROM deals d
    WHERE d.is_active = true
      AND to_tsvector('english',
        COALESCE(d.deal_number, '') || ' ' ||
        COALESCE(d.name, '') || ' ' ||
        COALESCE(d.description, '') || ' ' ||
        COALESCE(d.property_address, '')
      ) @@ plainto_tsquery('english', ${query})
    ORDER BY rank DESC
    LIMIT ${MAX_RESULTS_PER_TYPE}
  `);

  const rows = (result as any).rows ?? result;
  return rows.map((r: any): SearchResult => ({
    entityType: "deal",
    id: r.id,
    primaryLabel: r.name ?? "Unnamed Deal",
    secondaryLabel: r.deal_number ?? "",
    tertiaryLabel: [r.property_city, r.property_state].filter(Boolean).join(", ") || undefined,
    deepLink: `/deals/${r.id}`,
    rank: Number(r.rank ?? 0),
  }));
}

async function searchContacts(tenantDb: TenantDb, query: string): Promise<SearchResult[]> {
  const result = await tenantDb.execute(sql`
    SELECT
      c.id,
      c.first_name,
      c.last_name,
      c.email,
      c.company_name,
      c.phone,
      ts_rank(
        to_tsvector('english',
          COALESCE(c.first_name, '') || ' ' ||
          COALESCE(c.last_name, '') || ' ' ||
          COALESCE(c.email, '') || ' ' ||
          COALESCE(c.company_name, '') || ' ' ||
          COALESCE(c.phone, '')
        ),
        plainto_tsquery('english', ${query})
      ) AS rank
    FROM contacts c
    WHERE c.is_active = true
      AND to_tsvector('english',
        COALESCE(c.first_name, '') || ' ' ||
        COALESCE(c.last_name, '') || ' ' ||
        COALESCE(c.email, '') || ' ' ||
        COALESCE(c.company_name, '') || ' ' ||
        COALESCE(c.phone, '')
      ) @@ plainto_tsquery('english', ${query})
    ORDER BY rank DESC
    LIMIT ${MAX_RESULTS_PER_TYPE}
  `);

  const rows = (result as any).rows ?? result;
  return rows.map((r: any): SearchResult => ({
    entityType: "contact",
    id: r.id,
    primaryLabel: [r.first_name, r.last_name].filter(Boolean).join(" ") || "Unknown Contact",
    secondaryLabel: r.email ?? r.phone ?? "",
    tertiaryLabel: r.company_name ?? undefined,
    deepLink: `/contacts/${r.id}`,
    rank: Number(r.rank ?? 0),
  }));
}

async function searchFiles(tenantDb: TenantDb, query: string): Promise<SearchResult[]> {
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
    LIMIT ${MAX_RESULTS_PER_TYPE}
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

function buildTopEntityAnchors(structured: SearchResponse): AiSearchEntityAnchor[] {
  const anchors: AiSearchEntityAnchor[] = [];
  for (const result of [...structured.deals, ...structured.contacts, ...structured.files]) {
    anchors.push({
      entityType: result.entityType,
      id: result.id,
      label: result.primaryLabel,
      deepLink: result.deepLink,
    });
    if (anchors.length >= 3) break;
  }
  return anchors;
}
