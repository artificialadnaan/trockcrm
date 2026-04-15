import { sql, eq, and, gte } from "drizzle-orm";
import crypto from "crypto";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type * as schema from "@trock-crm/shared/schema";
import { aiFeedback, userOfficeAccess, offices, users } from "@trock-crm/shared/schema";
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
  actionType: "open_best_match" | "review_deal_emails" | "open_contact" | "open_file_context" | "open_deal_context";
  label: string;
  rationale: string;
  deepLink: string;
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
  const [evidence, interactionScores] = await Promise.all([
    searchAiEvidence(tenantDb, structured.query),
    getSearchInteractionScores(tenantDb),
  ]);
  const rankedEvidence = rankEvidenceByInteractions(evidence, interactionScores);
  const rankedTopEntities = buildTopEntityAnchors(structured, interactionScores);
  const rankedActions = buildRecommendedActions(structured, rankedEvidence, interactionScores);

  return {
    queryId: crypto.randomUUID(),
    query: structured.query,
    intent: classifySearchIntent(structured.query),
    summary: buildAiSearchSummary(structured, rankedEvidence),
    structured,
    topEntities: rankedTopEntities,
    recommendedActions: rankedActions,
    evidence: rankedEvidence,
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

function buildTopEntityAnchors(
  structured: SearchResponse,
  interactionScores: SearchInteractionScores
): AiSearchEntityAnchor[] {
  return [...structured.deals, ...structured.contacts, ...structured.files]
    .map((result, index) => ({
      anchor: {
        entityType: result.entityType,
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
  interactionScores: SearchInteractionScores
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
      actionType: "open_best_match",
      label: "Open Best Deal Match",
      rationale: `Jump to ${topDeal.primaryLabel} to inspect the strongest structured deal result.`,
      deepLink: topDeal.deepLink,
      interactionScore: scoreAction("open_best_match", topDeal.deepLink, interactionScores),
    });
    push({
      actionType: "review_deal_emails",
      label: "Review Deal Emails",
      rationale: `Open the email tab for ${topDeal.primaryLabel} to verify the communications behind this answer.`,
      deepLink: `${topDeal.deepLink}?tab=email`,
      interactionScore: scoreAction("review_deal_emails", `${topDeal.deepLink}?tab=email`, interactionScores),
    });
  }

  if (!topDeal && topEvidenceDeal) {
    push({
      actionType: "open_deal_context",
      label: "Open Deal Context",
      rationale: "The strongest AI evidence points to a specific deal context.",
      deepLink: `/deals/${topEvidenceDeal}`,
      interactionScore: scoreAction("open_deal_context", `/deals/${topEvidenceDeal}`, interactionScores),
    });
    push({
      actionType: "review_deal_emails",
      label: "Review Deal Emails",
      rationale: "Open the deal email context tied to the strongest evidence.",
      deepLink: `/deals/${topEvidenceDeal}?tab=email`,
      interactionScore: scoreAction("review_deal_emails", `/deals/${topEvidenceDeal}?tab=email`, interactionScores),
    });
  }

  if (topContact) {
    push({
      actionType: "open_contact",
      label: "Open Best Contact Match",
      rationale: `Jump to ${topContact.primaryLabel} to review the strongest contact result.`,
      deepLink: topContact.deepLink,
      interactionScore: scoreAction("open_contact", topContact.deepLink, interactionScores),
    });
  }

  if (topFile) {
    push({
      actionType: "open_file_context",
      label: "Open File Context",
      rationale: `Review the file location tied to ${topFile.primaryLabel}.`,
      deepLink: topFile.deepLink,
      interactionScore: scoreAction("open_file_context", topFile.deepLink, interactionScores),
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
}

async function getSearchInteractionScores(tenantDb: TenantDb): Promise<SearchInteractionScores> {
  const rows = (await tenantDb
    .select({
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
    )) as Array<{ feedbackValue: string; comment: string | null }>;

  const deepLinkCounts = new Map<string, number>();
  const actionCounts = new Map<string, number>();

  for (const row of rows) {
    if (!row.comment) continue;
    try {
      const parsed = JSON.parse(row.comment) as { targetValue?: string; deepLink?: string };
      if (parsed.deepLink) {
        deepLinkCounts.set(parsed.deepLink, (deepLinkCounts.get(parsed.deepLink) ?? 0) + 1);
      }
      if (parsed.targetValue) {
        actionCounts.set(parsed.targetValue, (actionCounts.get(parsed.targetValue) ?? 0) + 1);
      }
    } catch {
      continue;
    }
  }

  return { deepLinkCounts, actionCounts };
}

function scoreDeepLink(deepLink: string, interactionScores: SearchInteractionScores) {
  return interactionScores.deepLinkCounts.get(deepLink) ?? 0;
}

function scoreAction(actionType: string, deepLink: string, interactionScores: SearchInteractionScores) {
  return (interactionScores.actionCounts.get(actionType) ?? 0) + (interactionScores.deepLinkCounts.get(deepLink) ?? 0);
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
