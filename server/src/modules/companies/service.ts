import { eq, and, ilike, asc, desc, count, inArray, sql, getTableColumns, type SQL } from "drizzle-orm";
import { companies, contacts, deals, pipelineStageConfig, properties, users } from "@trock-crm/shared/schema";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { AppError } from "../../middleware/error-handler.js";
import { buildCompanySearchCondition } from "../search/unified-search.js";
import { normalizeDirectoryName } from "../../services/directoryDedup.js";
import {
  aliasedActiveDealCountFilterSql,
  aliasedDealBestEstimateWithForecastSql,
  aliasedTerminalAwareEffectiveDealValueSql,
  aliasedTerminalDealBySlugSql,
} from "../shared/deal-value-sql.js";

type TenantDb = NodePgDatabase<any>;

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .substring(0, 95); // leave room for dedup suffix
}

async function uniqueSlug(tenantDb: TenantDb, base: string, excludeId?: string): Promise<string> {
  let slug = base;
  let attempt = 0;
  while (true) {
    const conditions = [eq(companies.slug, slug)];
    if (excludeId) conditions.push(sql`${companies.id} != ${excludeId}`);
    const existing = await tenantDb.select({ id: companies.id }).from(companies).where(and(...conditions)).limit(1);
    if (existing.length === 0) return slug;
    attempt++;
    slug = `${base}-${attempt}`;
  }
}

/**
 * The on-hold-zeroed, forecast-first SUM of a company's ACTIVE-deal value. ONE expression embedded in
 * BOTH the summary-card aggregate (companyPipelineSql, a correlated subquery over baseWhere) AND the
 * folded per-row pipeline_value derived column (the deals LEFT JOIN that makes Pipeline$ sortable), so
 * the "Active pipeline" card === the SUM of the pipeline column over the list it drills to — reconcile by
 * construction, never drift. Reuses the shared deal-value resolver (forecast → awarded → … → bid_estimate)
 * and references the un-aliased `deals` relation that is in scope at every call site (the correlated
 * subquery's FROM and the GROUP BY company_id derived table both expose it as `deals`).
 */
// Company Pipeline$ — TERMINAL-aware/effective (Codex P2): a realized won/lost deal keeps its value
// (stored-on_hold only) while an OPEN deal auto-parks a far-out (90+ day) close target, so the company card,
// the folded list column, and the company-detail stat all read the same $ the deals list shows. Requires a
// joined pipeline_stage_config (every using query JOINs it as `pipeline_stage_config`).
function companyPipelineSumSql(): SQL {
  return sql`SUM(${aliasedTerminalAwareEffectiveDealValueSql(
    "deals",
    aliasedDealBestEstimateWithForecastSql("deals"),
    aliasedTerminalDealBySlugSql("deals", "pipeline_stage_config.slug")
  )})`;
}

/**
 * ORDER BY for the company directory, applied over the FULL filtered set before LIMIT/OFFSET so the sort
 * is global, not just the visible page. Direct company columns (name/owner/last_activity) plus the 4
 * FOLDED aggregate columns are supported: the aggregates are exposed by the per-relation derived-table
 * LEFT JOINs in listCompanies (p=properties, ct=contacts, d=deals), so they order the full set — counts
 * sort numerically and pipeline ($ stored as ::text) is cast back to numeric so it never sorts lexically.
 * Blanks/nulls always sink to the bottom in both directions (matching the client comparators' nulls-last
 * rule); listCompanies appends a stable asc(companies.id) tiebreak after this (heavy ties at value 0).
 * The sortBy → column mapping is a CLOSED switch (no raw-param column interpolation → no injection surface).
 */
export function buildCompanySortOrder(sortBy?: string, sortDir: "asc" | "desc" = "asc") {
  const col =
    sortBy === "owner"
      ? users.displayName
      : sortBy === "last_activity"
        ? companies.lastActivityAt
        : sortBy === "properties_count"
          ? sql`COALESCE(p.cnt, 0)`
          : sortBy === "contacts_count"
            ? sql`COALESCE(ct.cnt, 0)`
            : sortBy === "active_deals_count"
              ? sql`COALESCE(d.active_cnt, 0)`
              : sortBy === "pipeline_value"
                ? sql`COALESCE(d.pipeline::numeric, 0)`
                : companies.name;
  return sortDir === "asc" ? sql`${col} ASC NULLS LAST` : sql`${col} DESC NULLS LAST`;
}

export async function listCompanies(
  tenantDb: TenantDb,
  options: {
    search?: string;
    category?: string;
    industry?: string;
    ownerUserId?: string;
    // Summary-card drill-downs (?card=pipeline / ?card=stale on the companies page).
    hasActivePipeline?: boolean; // company has > 0 active (non-held) pipeline value
    stale?: boolean; // last activity is null or > 30 days ago
    sortBy?: string;
    sortDir?: "asc" | "desc";
    page?: number;
    limit?: number;
  } = {}
) {
  const page = options.page ?? 1;
  const limit = options.limit ?? 50;
  const offset = (page - 1) * limit;

  // Per-company predicates reused for BOTH the summary-card aggregates and the ?card= drill filters,
  // so each card's number === the count/sum of the list it drills to (reconcile by construction). The
  // pipeline SUM is the SHARED companyPipelineSumSql() — the identical expression the folded per-row
  // pipeline_value column uses below, so the card $ and the column $ can never drift.
  const companyPipelineSql = sql<string>`(
    SELECT COALESCE(${companyPipelineSumSql()}, 0)
      FROM deals
      LEFT JOIN pipeline_stage_config ON pipeline_stage_config.id = deals.stage_id
     WHERE deals.company_id = ${companies.id}
       AND deals.is_active = true
  )`;
  const companyStaleSql = sql<boolean>`(${companies.lastActivityAt} IS NULL OR ${companies.lastActivityAt} < NOW() - interval '30 days')`;

  const conditions = [eq(companies.isActive, true)];
  if (options.search && options.search.trim().length >= 2) {
    conditions.push(buildCompanySearchCondition(options.search));
  }
  if (options.category) {
    conditions.push(eq(companies.category, options.category as any));
  }
  if (options.industry) {
    conditions.push(eq(companies.industry, options.industry as any));
  }
  if (options.ownerUserId) {
    conditions.push(eq(companies.ownerId, options.ownerUserId));
  }
  // BASE where = the non-card filters. The card drill is layered on only for the LIST + pager; the
  // summary-card aggregates are computed over the BASE set so cards stay stable across drills and each
  // card === the count/sum of the list its OWN drill opens, even when switching cards (?card= REPLACES,
  // not composes). (Codex P2.)
  const baseWhere = and(...conditions);
  const listConditions = [...conditions];
  if (options.hasActivePipeline) {
    listConditions.push(sql`${companyPipelineSql} > 0`);
  }
  if (options.stale) {
    listConditions.push(companyStaleSql);
  }
  const where = and(...listConditions);

  // Per-relation PRE-AGGREGATED derived tables, each a single GROUP BY over the FK and joined 1:1, so the
  // 4 directory aggregates become real output columns the ORDER BY can reference and sort over the FULL
  // filtered set BEFORE limit/offset — what makes Properties/Contacts/Active-deals/Pipeline$ sortable.
  // Per-RELATION (never one multi-relation join) so COUNT/SUM can't fan out (3 deals × 2 contacts ×
  // 3 properties = 18 phantom rows). Counts cast ::int so the driver returns numbers (not bigint strings).
  const propAgg = tenantDb
    .select({
      companyId: properties.companyId,
      cnt: sql<number>`COUNT(*)::int`.as("cnt"),
    })
    .from(properties)
    .where(eq(properties.isActive, true))
    .groupBy(properties.companyId)
    .as("p");
  const contactAgg = tenantDb
    .select({
      companyId: contacts.companyId,
      cnt: sql<number>`COUNT(*)::int`.as("cnt"),
    })
    .from(contacts)
    .where(eq(contacts.isActive, true))
    .groupBy(contacts.companyId)
    .as("ct");
  const dealAgg = tenantDb
    .select({
      companyId: deals.companyId,
      // total active deals (held + non-held) for the "active/total" badge denominator
      totalCnt: sql<number>`COUNT(*)::int`.as("total_cnt"),
      // active, non-held deals = the badge numerator and the active_deals_count sort key
      activeCnt: sql<number>`CAST(COUNT(*) FILTER (WHERE COALESCE(${deals.onHold}, false) = false) AS int)`.as("active_cnt"),
      // pipeline $ via the SHARED resolver SUM — byte-identical to companyPipelineSql / pipelineTotal
      pipeline: sql<string>`COALESCE(${companyPipelineSumSql()}, 0)::text`.as("pipeline"),
    })
    .from(deals)
    // 1:1 stage join so companyPipelineSumSql can classify terminal rows (won't fan the COUNT aggregates).
    .leftJoin(pipelineStageConfig, eq(pipelineStageConfig.id, deals.stageId))
    .where(eq(deals.isActive, true))
    .groupBy(deals.companyId)
    .as("d");

  const rows = await tenantDb
    .select({
      ...getTableColumns(companies),
      ownerUserId: companies.ownerId,
      ownerUserName: users.displayName,
      // Folded aggregates (real columns; sortable). LEFT JOIN → no-match coalesces to 0 / '0'. Referenced
      // by RAW alias-qualified name (p/ct/d) — Drizzle drops the subquery-alias qualifier when an aliased
      // sql expression is embedded in a sql template, which would make the two `cnt` columns ambiguous;
      // the explicit prefix also matches the ORDER BY exprs in buildCompanySortOrder (reconcile-by-name).
      propertiesCount: sql<number>`COALESCE(p.cnt, 0)`,
      contactsCount: sql<number>`COALESCE(ct.cnt, 0)`,
      contactCount: sql<number>`COALESCE(ct.cnt, 0)`, // legacy alias (same value)
      activeDealsCount: sql<number>`COALESCE(d.active_cnt, 0)`,
      dealCount: sql<number>`COALESCE(d.total_cnt, 0)`, // legacy: all active deals (held + non-held)
      pipelineValue: sql<string>`COALESCE(d.pipeline, '0')`,
    })
    .from(companies)
    .leftJoin(users, eq(users.id, companies.ownerId))
    .leftJoin(propAgg, eq(propAgg.companyId, companies.id))
    .leftJoin(contactAgg, eq(contactAgg.companyId, companies.id))
    .leftJoin(dealAgg, eq(dealAgg.companyId, companies.id))
    .where(where)
    // Stable id tiebreak so OFFSET paging is deterministic when the primary sort ties (heavy at value 0).
    .orderBy(buildCompanySortOrder(options.sortBy, options.sortDir), asc(companies.id))
    .limit(limit)
    .offset(offset);
  const totalResult = await tenantDb
    .select({ count: count() })
    .from(companies)
    .where(where);

  // Stable summary-card aggregates over baseWhere (NOT the visible page, NOT card-drilled). baseTotal
  // feeds the "Total accounts" card; pipelineTotal/staleCount the other two. Same predicates as the
  // drill filters, so card === the count/sum of the list its drill opens. (UNTOUCHED by the folding.)
  const aggregateResult = await tenantDb
    .select({
      baseTotal: sql<number>`count(*)`,
      pipelineTotal: sql<string>`COALESCE(SUM(${companyPipelineSql}), 0)::text`,
      staleCount: sql<number>`COUNT(*) FILTER (WHERE ${companyStaleSql})`,
    })
    .from(companies)
    .where(baseWhere);

  // The per-page aggregates now ride on the rows themselves (folded above) — the old post-pagination
  // raw countRows query (a 2nd round-trip keyed on the already-paginated ids) is gone.
  const companiesWithCounts = rows;

  return {
    companies: companiesWithCounts,
    total: totalResult[0]?.count ?? 0,
    page,
    limit,
    // Stable summary-card values over the base (non-card) filters: baseTotal = "Total accounts",
    // pipelineTotal = "Active pipeline" ($ sum), staleCount = "Untouched". NOT page-only, NOT card-drilled.
    baseTotal: Number(aggregateResult[0]?.baseTotal ?? 0),
    pipelineTotal: Number(aggregateResult[0]?.pipelineTotal ?? 0),
    staleCount: Number(aggregateResult[0]?.staleCount ?? 0),
  };
}

export async function getCompanyById(tenantDb: TenantDb, id: string) {
  const rows = await tenantDb
    .select({
      ...getTableColumns(companies),
      ownerUserId: companies.ownerId,
      ownerUserName: users.displayName,
    })
    .from(companies)
    .leftJoin(users, eq(users.id, companies.ownerId))
    .where(eq(companies.id, id))
    .limit(1);
  return rows[0] ?? null;
}

export interface CompanyDedupSuggestion {
  id: string;
  name: string;
  address: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
  dealCount: number;
  matchReason: string;
}

export interface CompanyDedupResult {
  suggestions: CompanyDedupSuggestion[];
}

/**
 * Find ACTIVE companies that duplicate `name`, using the #538 merge tool's
 * NAME-ALONE match model (normalizeDirectoryName — case/suffix/punctuation
 * insensitive). That is the rule that catches the real deal-bearing duplicates:
 * the prod dups were created with NULL addresses, so an exact name+address rule
 * MISSES them (see .audit/company-dedup-discovery.md). WARN only — this never
 * blocks creation, it just surfaces the matches so the rep can pick the existing
 * company instead of minting another duplicate.
 */
export async function checkCompanyDuplicates(
  tenantDb: TenantDb,
  input: { name: string }
): Promise<CompanyDedupResult> {
  const normalizedTarget = normalizeDirectoryName(input.name);
  if (!normalizedTarget) return { suggestions: [] };

  // Suffix-stripping has no faithful SQL equivalent, so match in JS with the SAME
  // helper the merge tool uses (zero drift between detect-on-create and merge).
  // Company creation is a rare, deliberate action — scanning the active companies
  // here is cheap relative to the cost of a missed duplicate.
  const candidates = await tenantDb
    .select({
      id: companies.id,
      name: companies.name,
      address: companies.address,
      city: companies.city,
      state: companies.state,
      zip: companies.zip,
    })
    .from(companies)
    .where(eq(companies.isActive, true));

  const matches = candidates.filter(
    (c) => normalizeDirectoryName(c.name) === normalizedTarget
  );
  if (matches.length === 0) return { suggestions: [] };

  // Enrich ONLY the matched companies with their active deal count, so the rep
  // can pick the canonical record (the exact failure mode #538 cleaned up: deals
  // split across duplicates). Bounded to the handful of matches — cheap.
  const matchedIds = matches.map((m) => m.id);
  const dealCounts = await tenantDb
    .select({ companyId: deals.companyId, count: count() })
    .from(deals)
    .where(and(inArray(deals.companyId, matchedIds), eq(deals.isActive, true)))
    .groupBy(deals.companyId);
  const dealCountByCompany = new Map<string, number>(
    dealCounts.map((d) => [d.companyId as string, Number(d.count)])
  );

  const inputRawLower = input.name.trim().toLowerCase();
  const suggestions: CompanyDedupSuggestion[] = matches.map((m) => ({
    id: m.id,
    name: m.name,
    address: m.address ?? null,
    city: m.city ?? null,
    state: m.state ?? null,
    zip: m.zip ?? null,
    dealCount: dealCountByCompany.get(m.id) ?? 0,
    matchReason:
      m.name.trim().toLowerCase() === inputRawLower
        ? "Exact name match"
        : "Possible duplicate (same name, ignoring case/suffix)",
  }));

  // Most useful first: exact-name matches, then the record carrying the most deals.
  suggestions.sort((a, b) => {
    const aExact = a.matchReason === "Exact name match" ? 1 : 0;
    const bExact = b.matchReason === "Exact name match" ? 1 : 0;
    if (aExact !== bExact) return bExact - aExact;
    return b.dealCount - a.dealCount;
  });

  return { suggestions };
}

/**
 * Create a company. Runs checkCompanyDuplicates first (NAME-alone) unless
 * skipDedupCheck is true. On a duplicate-name match it does NOT insert and
 * returns { company: null, dedupResult } so the caller can WARN and let the rep
 * choose "use existing" or "create anyway" (re-call with skipDedupCheck=true).
 */
export async function createCompany(
  tenantDb: TenantDb,
  data: {
    name: string;
    category: string;
    address?: string;
    city?: string;
    state?: string;
    zip?: string;
    phone?: string;
    website?: string;
    notes?: string;
    // The user creating the company becomes its account owner ("whoever creates it owns it").
    // Optional + null-safe so non-interactive callers (imports/sync) can omit it and stay unowned.
    ownerUserId?: string | null;
  },
  skipDedupCheck = false
): Promise<{ company: typeof companies.$inferSelect | null; dedupResult?: CompanyDedupResult }> {
  if (!skipDedupCheck) {
    // Serialize the check+insert for the same normalized name so two concurrent
    // creates can't both pass the (read-then-write) dedup check and each insert a
    // duplicate. Transaction-scoped advisory lock keyed on the SAME normalized name
    // the match uses; auto-released at commit. No-op when the name normalizes to empty.
    const normalized = normalizeDirectoryName(data.name);
    if (normalized) {
      await tenantDb.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${normalized}))`);
    }
    const dedupResult = await checkCompanyDuplicates(tenantDb, { name: data.name });
    if (dedupResult.suggestions.length > 0) {
      return { company: null, dedupResult };
    }
  }

  const slug = await uniqueSlug(tenantDb, slugify(data.name));
  const rows = await tenantDb
    .insert(companies)
    .values({
      name: data.name,
      slug,
      category: data.category as any,
      address: data.address,
      city: data.city,
      state: data.state,
      zip: data.zip,
      phone: data.phone,
      website: data.website,
      notes: data.notes,
      ownerId: data.ownerUserId ?? null,
    })
    .returning();
  return { company: rows[0] };
}

export async function updateCompany(
  tenantDb: TenantDb,
  id: string,
  data: Partial<{
    name: string;
    category: string;
    address: string;
    city: string;
    state: string;
    zip: string;
    phone: string;
    website: string;
    notes: string;
  }>
) {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new AppError(400, "Company update payload must be an object");
  }

  if ("ownerId" in data || "ownerUserId" in data || "ownerUserName" in data) {
    throw new AppError(403, "Use the ownership reassignment endpoint to change company owner");
  }

  const updates: any = {};
  if (data.name !== undefined) updates.name = data.name;
  if (data.category !== undefined) updates.category = data.category as any;
  if (data.address !== undefined) updates.address = data.address;
  if (data.city !== undefined) updates.city = data.city;
  if (data.state !== undefined) updates.state = data.state;
  if (data.zip !== undefined) updates.zip = data.zip;
  if (data.phone !== undefined) updates.phone = data.phone;
  if (data.website !== undefined) updates.website = data.website;
  if (data.notes !== undefined) updates.notes = data.notes;
  if (data.name) updates.slug = await uniqueSlug(tenantDb, slugify(data.name), id);

  if (Object.keys(updates).length === 0) {
    return getCompanyById(tenantDb, id);
  }

  const rows = await tenantDb
    .update(companies)
    .set(updates)
    .where(eq(companies.id, id))
    .returning();
  return rows[0] ?? null;
}

export async function deleteCompany(tenantDb: TenantDb, companyId: string) {
  const existing = await getCompanyById(tenantDb, companyId);
  if (!existing) {
    throw new AppError(404, "Company not found");
  }

  if (!existing.isActive) {
    return null;
  }

  const rows = await tenantDb
    .update(companies)
    .set({ isActive: false })
    .where(eq(companies.id, companyId))
    .returning();

  return rows[0] ?? null;
}

export async function getCompanyContacts(tenantDb: TenantDb, companyId: string) {
  return tenantDb
    .select({
      ...getTableColumns(contacts),
      ownerUserId: contacts.ownerId,
      ownerUserName: users.displayName,
    })
    .from(contacts)
    .leftJoin(users, eq(users.id, contacts.ownerId))
    .where(and(eq(contacts.companyId, companyId), eq(contacts.isActive, true)))
    .orderBy(asc(contacts.lastName), asc(contacts.firstName));
}

export async function getCompanyDeals(tenantDb: TenantDb, companyId: string) {
  return tenantDb
    .select()
    .from(deals)
    .where(and(eq(deals.companyId, companyId), eq(deals.isActive, true)))
    .orderBy(desc(deals.createdAt));
}

export async function getCompanyStats(tenantDb: TenantDb, companyId: string) {
  const contactCount = await tenantDb.select({ count: count() }).from(contacts).where(and(eq(contacts.companyId, companyId), eq(contacts.isActive, true)));
  const dealCount = await tenantDb.select({ count: count() }).from(deals).where(and(eq(deals.companyId, companyId), eq(deals.isActive, true)));
  const activeDealsCountResult = await tenantDb.execute(sql`
    SELECT COUNT(*)::int AS count
    FROM deals d
    WHERE d.company_id = ${companyId}
      AND d.is_active = true
      AND ${aliasedActiveDealCountFilterSql("d")}
  `);
  const propertiesCount = await tenantDb.execute(sql`
    SELECT COUNT(*)::int AS count
    FROM properties
    WHERE company_id = ${companyId}
      AND is_active = true
  `);
  // TERMINAL-aware (Codex P2): a company's active deals are a MIXED set (open + realized won/lost), so the
  // value must preserve terminal rows (zeroed on stored on_hold only) while still auto-parking far-out OPEN
  // deals. Join the stage config for the CRM-stage terminal signal and OR in the Bid Board mirror, matching
  // the client/value-helper terminal exemption.
  const pipelineValue = await tenantDb.execute(sql`
    SELECT COALESCE(SUM(${aliasedTerminalAwareEffectiveDealValueSql("d", aliasedDealBestEstimateWithForecastSql("d"), aliasedTerminalDealBySlugSql("d", "psc.slug"))}), 0)::text AS pipeline_value
    FROM deals d
    LEFT JOIN pipeline_stage_config psc ON psc.id = d.stage_id
    WHERE d.company_id = ${companyId}
      AND d.is_active = true
  `);
  const propertyCountRows = (propertiesCount as any).rows ?? propertiesCount;
  const activeDealCountRows = (activeDealsCountResult as any).rows ?? activeDealsCountResult;
  const pipelineValueRows = (pipelineValue as any).rows ?? pipelineValue;
  const activeDealCount = dealCount[0]?.count ?? 0;
  const activeContactCount = contactCount[0]?.count ?? 0;

  return {
    contactCount: activeContactCount,
    dealCount: activeDealCount,
    propertiesCount: Number(propertyCountRows[0]?.count ?? 0),
    contactsCount: activeContactCount,
    activeDealsCount: Number(activeDealCountRows[0]?.count ?? 0),
    pipelineValue: String(pipelineValueRows[0]?.pipeline_value ?? "0"),
  };
}

export async function searchCompanies(tenantDb: TenantDb, query: string, limit = 10) {
  return tenantDb
    .select({
      id: companies.id,
      name: companies.name,
      category: companies.category,
      ownerUserId: companies.ownerId,
      ownerUserName: users.displayName,
    })
    .from(companies)
    .leftJoin(users, eq(users.id, companies.ownerId))
    .where(and(ilike(companies.name, `%${query}%`), eq(companies.isActive, true)))
    .orderBy(asc(companies.name))
    .limit(limit);
}
