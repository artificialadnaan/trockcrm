import { sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type * as schema from "@trock-crm/shared/schema";

type TenantDb = NodePgDatabase<typeof schema>;

export interface SearchResult {
  entityType: "deal" | "contact" | "file";
  id: string;
  primaryLabel: string;
  secondaryLabel: string;
  tertiaryLabel?: string;
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

const MAX_RESULTS_PER_TYPE = 5;

/**
 * Search across deals, contacts, and files using PostgreSQL full-text search.
 * Requires minimum 2-character query (enforced at route level).
 * Results are ranked by ts_rank and returned grouped by entity type.
 */
export async function globalSearch(
  tenantDb: TenantDb,
  query: string,
  types: Array<"deals" | "contacts" | "files"> = ["deals", "contacts", "files"]
): Promise<SearchResponse> {
  const sanitized = query.trim().replace(/[^\w\s-]/g, "").trim();
  if (sanitized.length < 2) {
    return { deals: [], contacts: [], files: [], total: 0, query };
  }

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
    query,
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
