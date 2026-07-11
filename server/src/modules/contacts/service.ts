import { eq, and, desc, asc, ilike, sql, or, not, isNull, inArray } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { activities, companies, contacts, contactDealAssociations, deals, emails, tasks, users } from "@trock-crm/shared/schema";
import type * as schema from "@trock-crm/shared/schema";
import { AppError } from "../../middleware/error-handler.js";
import { updateBreaksBillingAddress } from "../../lib/billing-address.js";
import { buildContactSearchCondition } from "../search/unified-search.js";

type TenantDb = NodePgDatabase<typeof schema>;
const INVALID_EMAIL_MESSAGE = "Please enter a valid email address.";
const INVALID_PHONE_MESSAGE = "Phone number is too long. Please use a 10-15 digit number.";
const DUPLICATE_EMAIL_MESSAGE =
  "A contact with this email already exists. Please use a different email or select the existing contact.";

export interface ContactFilters {
  search?: string;
  category?: string;
  companyName?: string;
  companyId?: string;
  jobTitle?: string;
  role?: string;
  city?: string;
  state?: string;
  regionId?: string;
  dealStageId?: string;
  isActive?: boolean;
  hasOutreach?: boolean; // filter by first_outreach_completed
  // Summary-card drill-downs. Each predicate is shared with the matching aggregate count in
  // getContacts so the card number and the filtered-list count reconcile by construction.
  isPrimary?: boolean; // has a primary deal association
  untouched?: boolean; // last touch is null or > 30 days ago
  hasLinkedDeals?: boolean; // has at least one ACTIVE linked deal (contact_deal_associations -> active deal)
  ownerUserId?: string;
  sortBy?: "name" | "company_name" | "created_at" | "updated_at" | "last_contacted_at" | "touchpoint_count" | "last_touch_at" | "linked_deals_count";
  sortDir?: "asc" | "desc";
  page?: number;
  limit?: number;
}

export interface CreateContactInput {
  firstName: string;
  lastName: string;
  email?: string | null;
  phone?: string | null;
  mobile?: string | null;
  companyName?: string | null;
  companyId?: string | null;
  jobTitle?: string | null;
  category: string;
  address?: string | null;
  city?: string | null;
  state?: string | null;
  zip?: string | null;
  notes?: string | null;
  procoreContactId?: number | null;
  hubspotContactId?: string | null;
  role?: string | null;
  linkedinUrl?: string | null;
  // The user creating the contact becomes its owner ("whoever creates it owns it"). Optional +
  // null-safe so non-interactive callers (imports/sync) can omit it and leave the contact unowned.
  ownerUserId?: string | null;
}

function validateEmailInput(email: string | null | undefined): void {
  const trimmed = email?.trim();
  if (trimmed && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) {
    throw new AppError(400, INVALID_EMAIL_MESSAGE);
  }
}

function normalizeOptionalPhone(phone: string | null | undefined): string | null {
  const trimmed = phone?.trim();
  if (!trimmed) return null;

  const digits = trimmed.replace(/\D/g, "");
  if (digits.length < 10 || digits.length > 15 || trimmed.length > 20) {
    throw new AppError(400, INVALID_PHONE_MESSAGE);
  }

  return trimmed;
}

function isEmailUniqueViolation(err: unknown): boolean {
  const candidates: unknown[] = [];
  let current: unknown = err;

  while (current && typeof current === "object" && !candidates.includes(current)) {
    candidates.push(current);
    current = (current as { cause?: unknown }).cause;
  }

  for (const candidate of [...candidates, ...candidates.map((candidate) => (candidate as { original?: unknown }).original)]) {
    if (!candidate || typeof candidate !== "object") continue;

    const errorLike = candidate as { code?: unknown; constraint?: unknown; detail?: unknown; message?: unknown };
    const constraint = typeof errorLike.constraint === "string" ? errorLike.constraint.toLowerCase() : "";
    const detail = typeof errorLike.detail === "string" ? errorLike.detail.toLowerCase() : "";
    const message = typeof errorLike.message === "string" ? errorLike.message.toLowerCase() : "";

    if (errorLike.code === "23505") {
      return constraint.includes("email") || detail.includes("(email)") || message.includes("email");
    }

    if (message.includes("unique constraint") && message.includes("email")) {
      return true;
    }
  }

  return false;
}

export interface UpdateContactInput {
  firstName?: string;
  lastName?: string;
  email?: string | null;
  phone?: string | null;
  mobile?: string | null;
  companyName?: string | null;
  jobTitle?: string | null;
  role?: string | null;
  category?: string;
  linkedinUrl?: string | null;
  address?: string | null;
  city?: string | null;
  state?: string | null;
  zip?: string | null;
  notes?: string | null;
}

export interface DedupCheckResult {
  hardBlock: boolean;
  existingContact?: {
    id: string;
    firstName: string;
    lastName: string;
    email: string | null;
    companyName: string | null;
  };
  fuzzySuggestions: Array<{
    id: string;
    firstName: string;
    lastName: string;
    email: string | null;
    companyName: string | null;
    // Candidates include soft-deleted contacts (email/name hard-block applies regardless of is_active), so
    // surface this flag — a "use this instead" consumer must not offer an inactive record (Codex P2).
    isActive: boolean;
    matchReason: string;
  }>;
}

const contactIdSql = sql.raw('"contacts"."id"');
const contactLastContactedAtSql = sql.raw('"contacts"."last_contacted_at"');

export function buildContactLastTouchAtSql(): SQL<Date | null> {
  return sql<Date | null>`NULLIF(GREATEST(
    COALESCE(${contactLastContactedAtSql}, '-infinity'::timestamptz),
    COALESCE((SELECT MAX(a.occurred_at) FROM activities a WHERE a.contact_id = ${contactIdSql}), '-infinity'::timestamptz),
    COALESCE((SELECT MAX(e.sent_at) FROM emails e WHERE e.contact_id = ${contactIdSql}), '-infinity'::timestamptz),
    COALESCE((SELECT MAX(t.updated_at) FROM tasks t WHERE t.contact_id = ${contactIdSql}), '-infinity'::timestamptz)
  ), '-infinity'::timestamptz)`;
}

export function buildContactIsPrimarySql(): SQL<boolean> {
  return sql<boolean>`EXISTS (
    SELECT 1
    FROM contact_deal_associations cda
    WHERE cda.contact_id = ${contactIdSql}
      AND cda.is_primary = true
  )`;
}

export function buildContactUntouchedSql(): SQL<boolean> {
  // Untouched 30d+: never touched (last touch NULL) OR last touch older than 30 days. Mirrors the
  // client predicate in contact-list-page.tsx; reused for BOTH the "Untouched" aggregate count and the
  // ?card=untouched drill filter so they reconcile.
  const lastTouch = buildContactLastTouchAtSql();
  return sql<boolean>`(${lastTouch} IS NULL OR ${lastTouch} < NOW() - interval '30 days')`;
}

export function buildContactLinkedDealsCountSql(): SQL<number> {
  return sql<number>`(
    SELECT COUNT(*)::int
    FROM contact_deal_associations cda
    INNER JOIN deals d ON d.id = cda.deal_id
    WHERE cda.contact_id = ${contactIdSql}
      AND d.is_active = true
  )`;
}

export function buildContactHasLinkedActiveDealSql(): SQL<boolean> {
  // Filter predicate for "contacts with at least one ACTIVE linked deal" — same EXISTS shape as the
  // buildContactLinkedDealsCountSql count subquery (contact_deal_associations -> active deal), but as a
  // boolean EXISTS so it can drive the WHERE without a COUNT. contact_deal_associations is empty in
  // office_dallas today, so this correctly returns an empty set until associations exist.
  return sql<boolean>`EXISTS (
    SELECT 1
    FROM contact_deal_associations cda
    INNER JOIN deals d ON d.id = cda.deal_id
    WHERE cda.contact_id = ${contactIdSql}
      AND d.is_active = true
  )`;
}

export function buildContactSortOrder(sortBy: ContactFilters["sortBy"], sortDir: ContactFilters["sortDir"] = "desc") {
  if (sortBy === "last_touch_at") {
    const lastTouchAt = buildContactLastTouchAtSql();
    return sortDir === "asc" ? asc(lastTouchAt) : sql`${lastTouchAt} DESC NULLS LAST`;
  }

  if (sortBy === "linked_deals_count") {
    // Sort key IS buildContactLinkedDealsCountSql — the SAME COUNT subquery rendered for the displayed
    // "Linked deals" count — so the sort key is byte-identical to the displayed value (no drift).
    const linkedDeals = buildContactLinkedDealsCountSql();
    return sortDir === "asc" ? sql`${linkedDeals} ASC NULLS LAST` : sql`${linkedDeals} DESC NULLS LAST`;
  }

  if (sortBy === "company_name") {
    // Sort by the SAME value the list now DISPLAYS: the linked company's real name (companies.name via
    // company_id) when present, else the free-text company_name. Sorting on the raw company_name alone
    // would scatter every contact whose name is resolved from the linked company (blank text → NULLS LAST)
    // away from where it visibly sorts. Requires getContacts to join companies (it does).
    const resolvedCompanyName = sql`COALESCE(${companies.name}, ${contacts.companyName})`;
    return sortDir === "asc"
      ? sql`${resolvedCompanyName} ASC NULLS LAST`
      : sql`${resolvedCompanyName} DESC NULLS LAST`;
  }

  const sortColumn = (() => {
    switch (sortBy) {
      case "name": return contacts.lastName;
      case "created_at": return contacts.createdAt;
      case "last_contacted_at": return contacts.lastContactedAt;
      case "touchpoint_count": return contacts.touchpointCount;
      default: return contacts.updatedAt;
    }
  })();
  // NULLS LAST in BOTH directions (matches the client comparators + the company/property sort builders):
  // Postgres defaults DESC to NULLS FIRST, which would float blanks (e.g. a null company_name) to the top
  // on a descending sort — the now-clickable "Company" header makes that reachable.
  return sortDir === "asc" ? sql`${sortColumn} ASC NULLS LAST` : sql`${sortColumn} DESC NULLS LAST`;
}

/**
 * Normalize a name for fuzzy comparison: lowercase, trim, collapse whitespace.
 */
function normalizeName(firstName: string, lastName: string): string {
  return `${firstName} ${lastName}`.toLowerCase().trim().replace(/\s+/g, " ");
}

/**
 * Levenshtein distance between two strings (JS implementation).
 * Used for first-name similarity checks in the pre-creation dedup flow
 * instead of the PostgreSQL fuzzystrmatch extension.
 */
function levenshteinDistance(a: string, b: string): number {
  const m = a.length, n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let prev = Array.from({ length: n + 1 }, (_, i) => i);
  for (let i = 1; i <= m; i++) {
    const curr = [i];
    for (let j = 1; j <= n; j++) {
      curr[j] = a[i - 1] === b[j - 1]
        ? prev[j - 1]
        : 1 + Math.min(prev[j - 1], prev[j], curr[j - 1]);
    }
    prev = curr;
  }
  return prev[n];
}

/**
 * Check for duplicate contacts before creation.
 *
 * 1. Exact email match -> hard block (409)
 * 2. Fuzzy name+company match -> suggestions (user decides)
 */
export async function checkForDuplicates(
  tenantDb: TenantDb,
  input: { firstName: string; lastName: string; email?: string | null; companyName?: string | null }
): Promise<DedupCheckResult> {
  const result: DedupCheckResult = { hardBlock: false, fuzzySuggestions: [] };

  // 1. Exact email match (hard block)
  // Check ALL contacts (including inactive) because the DB unique index
  // on email applies regardless of is_active.
  if (input.email && input.email.trim().length > 0) {
    const normalizedEmail = input.email.trim().toLowerCase();
    const emailMatch = await tenantDb
      .select({
        id: contacts.id,
        firstName: contacts.firstName,
        lastName: contacts.lastName,
        email: contacts.email,
        companyName: contacts.companyName,
      })
      .from(contacts)
      .where(
        sql`LOWER(${contacts.email}) = ${normalizedEmail}`
      )
      .limit(1);

    if (emailMatch.length > 0) {
      result.hardBlock = true;
      result.existingContact = emailMatch[0];
      return result;
    }
  }

  // 2. Fuzzy name + company match (suggestions)
  const normalizedInput = normalizeName(input.firstName, input.lastName);

  // Build conditions for fuzzy matching:
  // - Similar normalized name (case-insensitive LIKE with first+last)
  // - OR same company name (case-insensitive)
  // Query ALL contacts (active + inactive) — the DB unique index on email
  // applies regardless of is_active, so inactive contacts still block creation.
  const conditions: any[] = [];

  // SQL: fetch candidates by last-name match only (active + inactive).
  // First-name similarity is evaluated in JS via Levenshtein distance so we
  // catch typos / nicknames that an exact SQL match would miss.
  const fuzzyConditions: any[] = [
    sql`LOWER(${contacts.lastName}) = LOWER(${input.lastName.trim()})`,
  ];

  // Also include company+lastName matches when company is provided
  if (input.companyName && input.companyName.trim().length > 0) {
    fuzzyConditions.push(
      and(
        sql`LOWER(${contacts.companyName}) = LOWER(${input.companyName.trim()})`,
        sql`LOWER(${contacts.lastName}) = LOWER(${input.lastName.trim()})`
      )
    );
  }

  const candidates = await tenantDb
    .select({
      id: contacts.id,
      firstName: contacts.firstName,
      lastName: contacts.lastName,
      email: contacts.email,
      companyName: contacts.companyName,
      isActive: contacts.isActive,
    })
    .from(contacts)
    // Only ACTIVE contacts are offered as "use this instead" suggestions — a soft-deleted/merged record is
    // not assignable, and returning only-inactive matches would leave the caller unable to create at all
    // (the exact-email/name HARD-block below still considers inactive, independently).
    .where(and(...conditions, or(...fuzzyConditions), eq(contacts.isActive, true)))
    .limit(50); // fetch more candidates; JS Levenshtein narrows below

  // JS: filter by first-name Levenshtein distance < 3 to catch typos/nicknames
  const inputFirstLower = input.firstName.trim().toLowerCase();
  const filtered = candidates.filter((c) => {
    const dist = levenshteinDistance(c.firstName?.toLowerCase() ?? "", inputFirstLower);
    return dist < 3;
  });

  result.fuzzySuggestions = filtered.slice(0, 5).map((match) => ({
    ...match,
    matchReason:
      normalizeName(match.firstName, match.lastName) === normalizedInput
        ? "Exact name match"
        : match.companyName?.toLowerCase() === input.companyName?.toLowerCase()
          ? "Same last name + company"
          : "Same name",
  }));

  return result;
}

/**
 * Get a paginated, filtered, sorted list of contacts.
 */
export async function getContacts(tenantDb: TenantDb, filters: ContactFilters) {
  const page = filters.page ?? 1;
  const limit = filters.limit ?? 50;
  const offset = (page - 1) * limit;

  const conditions: any[] = [];

  // Active filter (default: true)
  const showActive = filters.isActive ?? true;
  conditions.push(eq(contacts.isActive, showActive));

  // Category filter
  if (filters.category) {
    conditions.push(eq(contacts.category, filters.category as any));
  }

  // Company filter — match the DISPLAYED company name: the free-text company_name OR the LINKED company's
  // real name (companies.name via company_id), so filtering by what the list shows returns the row (a linked
  // contact with a null/stale free-text name is no longer excluded). EXISTS (not a join) so the SAME predicate
  // works in the list query AND the count/card-aggregate queries, which don't join companies.
  if (filters.companyName) {
    const companyTerm = `%${filters.companyName}%`;
    conditions.push(
      or(
        ilike(contacts.companyName, companyTerm),
        sql`EXISTS (SELECT 1 FROM companies fc WHERE fc.id = ${contacts.companyId} AND fc.name ILIKE ${companyTerm})`
      )
    );
  }

  // Company filter (by company ID — direct column on contacts)
  if (filters.companyId) {
    conditions.push(eq(contacts.companyId, filters.companyId));
  }

  // Job title filter
  if (filters.jobTitle) {
    conditions.push(ilike(contacts.jobTitle, `%${filters.jobTitle}%`));
  }
  if (filters.role) {
    conditions.push(eq(contacts.role, filters.role as any));
  }
  if (filters.ownerUserId) {
    conditions.push(eq(contacts.ownerId, filters.ownerUserId));
  }

  // Linked-deals filter: only contacts with an EXISTS active linked deal. A BASE filter (like role/owner),
  // so the summary-card aggregates reflect it and it AND-composes with search/scope/sort/pagination.
  if (filters.hasLinkedDeals === true) {
    conditions.push(buildContactHasLinkedActiveDealSql());
  }

  // City filter
  if (filters.city) {
    conditions.push(ilike(contacts.city, `%${filters.city}%`));
  }

  // State filter
  if (filters.state) {
    conditions.push(eq(contacts.state, filters.state));
  }

  // Region filter — join through associations → deals
  if (filters.regionId) {
    const contactIdsInRegion = tenantDb
      .select({ contactId: contactDealAssociations.contactId })
      .from(contactDealAssociations)
      .innerJoin(deals, eq(contactDealAssociations.dealId, deals.id))
      .where(eq(deals.regionId, filters.regionId));
    conditions.push(inArray(contacts.id, contactIdsInRegion));
  }

  // Deal stage filter — join through associations → deals
  if (filters.dealStageId) {
    const contactIdsInStage = tenantDb
      .select({ contactId: contactDealAssociations.contactId })
      .from(contactDealAssociations)
      .innerJoin(deals, eq(contactDealAssociations.dealId, deals.id))
      .where(eq(deals.stageId, filters.dealStageId));
    conditions.push(inArray(contacts.id, contactIdsInStage));
  }

  // Outreach filter
  if (filters.hasOutreach === false) {
    conditions.push(eq(contacts.firstOutreachCompleted, false));
  } else if (filters.hasOutreach === true) {
    conditions.push(eq(contacts.firstOutreachCompleted, true));
  }

  // Substring search across name, email, company, phone/mobile, job title, city, and owner —
  // the shared unified field set (single source of truth in modules/search/unified-search).
  if (filters.search && filters.search.trim().length >= 2) {
    conditions.push(buildContactSearchCondition(filters.search));
  }

  // BASE where = the non-card filters (search/role/owner/…). The card drill is layered on top only for
  // the LIST + pager; the summary-card aggregates are computed over the BASE set. Cards therefore stay
  // stable across drills, and each card's number === the count of the list ITS OWN drill opens — even
  // when switching directly between cards (the ?card= links REPLACE, not compose). (Codex P2.)
  const baseWhere = conditions.length > 0 ? and(...conditions) : undefined;
  const listConditions = [...conditions];
  if (filters.isPrimary === true) listConditions.push(buildContactIsPrimarySql());
  if (filters.untouched === true) listConditions.push(buildContactUntouchedSql());
  const where = listConditions.length > 0 ? and(...listConditions) : undefined;

  // Sort
  const sortOrder = buildContactSortOrder(filters.sortBy, filters.sortDir);

  // Stable summary-card aggregates over baseWhere (NOT page-limited, NOT card-drilled). baseTotal feeds
  // the "Total contacts" card; primary/untouched the other two. The FILTER predicates are the SAME
  // helpers as the drill filters above, so card number === count of the list its drill opens.
  const cardCounts = await tenantDb
    .select({
      baseTotal: sql<number>`count(*)`,
      primaryCount: sql<number>`count(*) FILTER (WHERE ${buildContactIsPrimarySql()})`,
      untouchedCount: sql<number>`count(*) FILTER (WHERE ${buildContactUntouchedSql()})`,
    })
    .from(contacts)
    .where(baseWhere);
  // Pager total over the drilled list.
  const countResult = await tenantDb.select({ count: sql<number>`count(*)` }).from(contacts).where(where);
  const contactRows = await tenantDb
    .select({
      id: contacts.id,
      firstName: contacts.firstName,
      lastName: contacts.lastName,
      email: contacts.email,
      phone: contacts.phone,
      mobile: contacts.mobile,
      companyName: contacts.companyName,
      companyId: contacts.companyId,
      // Authoritative display name: the LINKED company's real name (companies.name via company_id), which
      // the free-text company_name column often doesn't carry (null/stale on imported contacts). The UI
      // prefers this so a contact linked to a real company stops reading "Unassigned"/"Unknown company".
      linkedCompanyName: companies.name,
      ownerUserId: contacts.ownerId,
      ownerUserName: users.displayName,
      jobTitle: contacts.jobTitle,
      category: contacts.category,
      role: contacts.role,
      linkedinUrl: contacts.linkedinUrl,
      address: contacts.address,
      city: contacts.city,
      state: contacts.state,
      zip: contacts.zip,
      notes: contacts.notes,
      touchpointCount: contacts.touchpointCount,
      lastContactedAt: contacts.lastContactedAt,
      firstOutreachCompleted: contacts.firstOutreachCompleted,
      procoreContactId: contacts.procoreContactId,
      hubspotContactId: contacts.hubspotContactId,
      sourceRefs: contacts.sourceRefs,
      normalizedPhone: contacts.normalizedPhone,
      isTestData: contacts.isTestData,
      isActive: contacts.isActive,
      createdAt: contacts.createdAt,
      updatedAt: contacts.updatedAt,
      isPrimary: buildContactIsPrimarySql(),
      linkedDealsCount: buildContactLinkedDealsCountSql(),
      lastTouchAt: buildContactLastTouchAtSql(),
    })
    .from(contacts)
    .leftJoin(users, eq(users.id, contacts.ownerId))
    .leftJoin(companies, eq(companies.id, contacts.companyId))
    .where(where)
    // Stable secondary key so OFFSET pagination is deterministic when the primary sort ties
    // (e.g. equal last_touch_at / company / role) — without it, rows can repeat or vanish across pages.
    .orderBy(sortOrder, asc(contacts.id))
    .limit(limit)
    .offset(offset);

  const total = Number(countResult[0]?.count ?? 0);

  return {
    contacts: contactRows,
    pagination: {
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit),
      // Stable, full-set summary-card counts over the base (non-card) filters. baseTotal = the "Total
      // contacts" card; primary/untouched the other two. NOT page-only, NOT narrowed by the active card.
      baseTotal: Number(cardCounts[0]?.baseTotal ?? 0),
      primaryCount: Number(cardCounts[0]?.primaryCount ?? 0),
      untouchedCount: Number(cardCounts[0]?.untouchedCount ?? 0),
    },
  };
}

/**
 * Get a single contact by ID.
 */
export async function getContactById(tenantDb: TenantDb, contactId: string) {
  const result = await tenantDb
    .select({
      id: contacts.id,
      firstName: contacts.firstName,
      lastName: contacts.lastName,
      email: contacts.email,
      phone: contacts.phone,
      mobile: contacts.mobile,
      companyName: contacts.companyName,
      companyId: contacts.companyId,
      // See getContacts: the linked company's real name, preferred by the detail header/sidebar over the
      // free-text company_name so a contact with company_id set never shows "Unknown company".
      linkedCompanyName: companies.name,
      jobTitle: contacts.jobTitle,
      category: contacts.category,
      role: contacts.role,
      linkedinUrl: contacts.linkedinUrl,
      address: contacts.address,
      city: contacts.city,
      state: contacts.state,
      zip: contacts.zip,
      notes: contacts.notes,
      touchpointCount: contacts.touchpointCount,
      lastContactedAt: contacts.lastContactedAt,
      firstOutreachCompleted: contacts.firstOutreachCompleted,
      procoreContactId: contacts.procoreContactId,
      hubspotContactId: contacts.hubspotContactId,
      sourceRefs: contacts.sourceRefs,
      normalizedPhone: contacts.normalizedPhone,
      isTestData: contacts.isTestData,
      isActive: contacts.isActive,
      createdAt: contacts.createdAt,
      updatedAt: contacts.updatedAt,
      isPrimary: buildContactIsPrimarySql(),
      linkedDealsCount: buildContactLinkedDealsCountSql(),
      lastTouchAt: buildContactLastTouchAtSql(),
    })
    .from(contacts)
    .leftJoin(companies, eq(companies.id, contacts.companyId))
    .where(eq(contacts.id, contactId))
    .limit(1);

  return result[0] ?? null;
}

/**
 * Create a new contact. Caller should run checkForDuplicates first
 * unless skipDedupCheck is true.
 */
export async function createContact(
  tenantDb: TenantDb,
  input: CreateContactInput,
  skipDedupCheck = false
): Promise<{ contact: any; dedupResult?: DedupCheckResult }> {
  validateEmailInput(input.email);
  const normalizedPhone = normalizeOptionalPhone(input.phone);
  const normalizedMobile = normalizeOptionalPhone(input.mobile);

  // Run dedup check unless explicitly skipped
  if (!skipDedupCheck) {
    const dedupResult = await checkForDuplicates(tenantDb, {
      firstName: input.firstName,
      lastName: input.lastName,
      email: input.email,
      companyName: input.companyName,
    });

    if (dedupResult.hardBlock) {
      throw new AppError(
        409,
        `A contact with email "${input.email}" already exists: ${dedupResult.existingContact!.firstName} ${dedupResult.existingContact!.lastName}`,
        "DUPLICATE_EMAIL"
      );
    }

    if (dedupResult.fuzzySuggestions.length > 0) {
      return { contact: null, dedupResult };
    }
  }

  // Normalize email: lowercase + trim to prevent case-variant duplicates
  const normalizedEmail = input.email?.trim().toLowerCase() || null;

  let result;
  try {
    result = await tenantDb
      .insert(contacts)
      .values({
        firstName: input.firstName,
        lastName: input.lastName,
        email: normalizedEmail,
        phone: normalizedPhone,
        mobile: normalizedMobile,
        companyName: input.companyName?.trim() || null,
        companyId: input.companyId ?? null,
        jobTitle: input.jobTitle?.trim() || null,
        category: input.category as any,
        role: input.role as any ?? null,
        linkedinUrl: input.linkedinUrl?.trim() || null,
        address: input.address?.trim() || null,
        city: input.city?.trim() || null,
        state: input.state?.trim() || null,
        zip: input.zip?.trim() || null,
        notes: input.notes?.trim() || null,
        procoreContactId: input.procoreContactId ?? null,
        hubspotContactId: input.hubspotContactId ?? null,
        ownerId: input.ownerUserId ?? null,
      })
      .returning();
  } catch (err: any) {
    // Fallback: catch unique violation on email (23505) as a safety net
    // in case the dedup check was skipped or a race condition occurred.
    if (isEmailUniqueViolation(err)) {
      throw new AppError(409, DUPLICATE_EMAIL_MESSAGE, "DUPLICATE_EMAIL");
    }
    throw err;
  }

  return { contact: result[0] };
}

/**
 * Update an existing contact.
 */
export async function updateContact(
  tenantDb: TenantDb,
  contactId: string,
  input: UpdateContactInput
) {
  const existing = await getContactById(tenantDb, contactId);
  if (!existing) {
    throw new AppError(404, "Contact not found");
  }

  // Normalize email before comparison or storage
  if (input.email !== undefined) {
    input.email = input.email?.trim().toLowerCase() || null;
  }

  // If email is being changed, check for duplicates across ALL contacts
  // (including inactive) because the DB unique index applies regardless of is_active.
  if (input.email !== undefined && input.email !== existing.email) {
    if (input.email && input.email.length > 0) {
      const emailMatch = await tenantDb
        .select({ id: contacts.id })
        .from(contacts)
        .where(
          and(
            sql`LOWER(${contacts.email}) = ${input.email}`,
            not(eq(contacts.id, contactId))
          )
        )
        .limit(1);

      if (emailMatch.length > 0) {
        throw new AppError(409, `A contact with email "${input.email}" already exists`, "DUPLICATE_EMAIL");
      }
    }
  }

  const updates: Record<string, any> = {};
  if (input.firstName !== undefined) updates.firstName = input.firstName;
  if (input.lastName !== undefined) updates.lastName = input.lastName;
  if (input.email !== undefined) updates.email = input.email || null;
  if (input.phone !== undefined) updates.phone = normalizeOptionalPhone(input.phone);
  if (input.mobile !== undefined) updates.mobile = normalizeOptionalPhone(input.mobile);
  if (input.companyName !== undefined) updates.companyName = input.companyName?.trim() || null;
  if (input.jobTitle !== undefined) updates.jobTitle = input.jobTitle?.trim() || null;
  if (input.role !== undefined) updates.role = input.role || null;
  if (input.category !== undefined) updates.category = input.category;
  if (input.linkedinUrl !== undefined) updates.linkedinUrl = input.linkedinUrl?.trim() || null;
  if (input.address !== undefined) updates.address = input.address?.trim() || null;
  if (input.city !== undefined) updates.city = input.city?.trim() || null;
  if (input.state !== undefined) updates.state = input.state?.trim() || null;
  if (input.zip !== undefined) updates.zip = input.zip?.trim() || null;
  if (input.notes !== undefined) updates.notes = input.notes?.trim() || null;

  if (Object.keys(updates).length === 0) {
    return existing;
  }

  // Don't let a contact edit strip the address off a contact that's actively the billing contact on a deal —
  // that would silently leave the deal with an un-invoiceable billing contact, bypassing the assign-time gate.
  // Forward-only: only a complete -> incomplete change is blocked; an already-incomplete address isn't forced
  // to be cleaned up (Codex P2).
  if (updateBreaksBillingAddress(existing, updates)) {
    // Lock this contact's row FOR UPDATE so a concurrent deal billing-assignment — which also locks the contact
    // via validateDealBillingContact before repointing the deal — serializes with this edit. Without it, the
    // deal could validate a still-complete contact and commit between our reference check and the UPDATE below,
    // leaving the deal with an incomplete billing contact. Whoever grabs the contact lock first wins; the lock
    // is held for the rest of this transaction (Codex P2 TOCTOU).
    await tenantDb.select({ id: contacts.id }).from(contacts).where(eq(contacts.id, contactId)).limit(1).for("update");
    const [billingRef] = await tenantDb
      .select({ id: deals.id })
      .from(deals)
      .where(and(eq(deals.billingContactId, contactId), eq(deals.isActive, true)))
      .limit(1);
    if (billingRef) {
      throw new AppError(400, "This contact is the billing contact on an active deal — keep a complete mailing address (street, city, state, and ZIP).");
    }
  }

  const result = await tenantDb
    .update(contacts)
    .set(updates)
    .where(eq(contacts.id, contactId))
    .returning();

  return result[0];
}

/**
 * Soft-delete a contact.
 * Only directors/admins can delete.
 */
export async function deleteContact(tenantDb: TenantDb, contactId: string, userRole: string) {
  if (userRole === "rep") {
    throw new AppError(403, "Only directors and admins can delete contacts");
  }

  const [existing] = await tenantDb.select().from(contacts).where(eq(contacts.id, contactId)).limit(1);
  if (!existing) {
    throw new AppError(404, "Contact not found");
  }

  if (!existing.isActive) {
    return null;
  }

  const result = await tenantDb
    .update(contacts)
    .set({ isActive: false })
    .where(eq(contacts.id, contactId))
    .returning();

  if (result.length === 0) {
    throw new AppError(404, "Contact not found");
  }

  // Soft-delete only flips is_active, so the deals FK ON DELETE SET NULL never fires. Clear this contact as a
  // deal's BILLING contact so getDealDetail stops surfacing an archived contact and the future Won gate
  // (billing_contact_id IS NULL) isn't falsely satisfied by a contact users can no longer select (Codex P2).
  await tenantDb.update(deals).set({ billingContactId: null }).where(eq(deals.billingContactId, contactId));

  return result[0];
}

/**
 * Get contacts that have not completed first outreach (touchpoint alerts).
 */
export async function getContactsNeedingOutreach(tenantDb: TenantDb, limit = 20) {
  return tenantDb
    .select()
    .from(contacts)
    .where(
      and(
        eq(contacts.isActive, true),
        eq(contacts.firstOutreachCompleted, false)
      )
    )
    .orderBy(asc(contacts.createdAt))
    .limit(limit);
}

/**
 * Get distinct company names for filter dropdowns. Returns the RESOLVED name (linked companies.name over the
 * free-text company_name) so the dropdown lists what the list displays and what the companyName filter now
 * matches — a contact linked to a real company is offered by that company even when its free-text company_name
 * is null/stale.
 */
export async function getCompanyNames(tenantDb: TenantDb) {
  const resolvedName = sql<string>`COALESCE(${companies.name}, ${contacts.companyName})`;
  const result = await tenantDb
    .selectDistinct({ companyName: resolvedName })
    .from(contacts)
    .leftJoin(companies, eq(companies.id, contacts.companyId))
    .where(and(eq(contacts.isActive, true), sql`COALESCE(${companies.name}, ${contacts.companyName}) IS NOT NULL`))
    .orderBy(asc(resolvedName));

  return result.map((r) => r.companyName).filter(Boolean) as string[];
}
