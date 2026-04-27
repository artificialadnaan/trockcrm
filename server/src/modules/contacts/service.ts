import { eq, and, desc, asc, ilike, sql, or, not, isNull, inArray } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { contacts, contactDealAssociations, deals } from "@trock-crm/shared/schema";
import type * as schema from "@trock-crm/shared/schema";
import { AppError } from "../../middleware/error-handler.js";

type TenantDb = NodePgDatabase<typeof schema>;

export interface ContactFilters {
  search?: string;
  category?: string;
  companyName?: string;
  companyId?: string;
  jobTitle?: string;
  city?: string;
  state?: string;
  regionId?: string;
  dealStageId?: string;
  isActive?: boolean;
  hasOutreach?: boolean; // filter by first_outreach_completed
  sortBy?: "name" | "company_name" | "created_at" | "updated_at" | "last_contacted_at" | "touchpoint_count";
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
}

export interface UpdateContactInput {
  firstName?: string;
  lastName?: string;
  email?: string | null;
  phone?: string | null;
  mobile?: string | null;
  companyName?: string | null;
  jobTitle?: string | null;
  category?: string;
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
    matchReason: string;
  }>;
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
    })
    .from(contacts)
    .where(and(...conditions, or(...fuzzyConditions)))
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

  // Company filter (name ILIKE)
  if (filters.companyName) {
    conditions.push(ilike(contacts.companyName, `%${filters.companyName}%`));
  }

  // Company filter (by company ID — direct column on contacts)
  if (filters.companyId) {
    conditions.push(eq(contacts.companyId, filters.companyId));
  }

  // Job title filter
  if (filters.jobTitle) {
    conditions.push(ilike(contacts.jobTitle, `%${filters.jobTitle}%`));
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

  // Full-text search across name, email, company, phone
  if (filters.search && filters.search.trim().length >= 2) {
    const searchTerm = `%${filters.search.trim()}%`;
    conditions.push(
      or(
        ilike(contacts.firstName, searchTerm),
        ilike(contacts.lastName, searchTerm),
        sql`${contacts.firstName} || ' ' || ${contacts.lastName} ILIKE ${searchTerm}`,
        ilike(contacts.email, searchTerm),
        ilike(contacts.companyName, searchTerm),
        ilike(contacts.phone, searchTerm),
        ilike(contacts.mobile, searchTerm),
        ilike(contacts.jobTitle, searchTerm)
      )
    );
  }

  const where = conditions.length > 0 ? and(...conditions) : undefined;

  // Sort
  const sortColumn = (() => {
    switch (filters.sortBy) {
      case "name": return contacts.lastName;
      case "company_name": return contacts.companyName;
      case "created_at": return contacts.createdAt;
      case "last_contacted_at": return contacts.lastContactedAt;
      case "touchpoint_count": return contacts.touchpointCount;
      default: return contacts.updatedAt;
    }
  })();
  const sortOrder = filters.sortDir === "asc" ? asc(sortColumn) : desc(sortColumn);

  const [countResult, contactRows] = await Promise.all([
    tenantDb.select({ count: sql<number>`count(*)` }).from(contacts).where(where),
    tenantDb
      .select()
      .from(contacts)
      .where(where)
      .orderBy(sortOrder)
      .limit(limit)
      .offset(offset),
  ]);

  const total = Number(countResult[0]?.count ?? 0);

  return {
    contacts: contactRows,
    pagination: {
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit),
    },
  };
}

/**
 * Get a single contact by ID.
 */
export async function getContactById(tenantDb: TenantDb, contactId: string) {
  const result = await tenantDb
    .select()
    .from(contacts)
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
        phone: input.phone?.trim() || null,
        mobile: input.mobile?.trim() || null,
        companyName: input.companyName?.trim() || null,
        companyId: input.companyId ?? null,
        jobTitle: input.jobTitle?.trim() || null,
        category: input.category as any,
        address: input.address?.trim() || null,
        city: input.city?.trim() || null,
        state: input.state?.trim() || null,
        zip: input.zip?.trim() || null,
        notes: input.notes?.trim() || null,
        procoreContactId: input.procoreContactId ?? null,
        hubspotContactId: input.hubspotContactId ?? null,
      })
      .returning();
  } catch (err: any) {
    // Fallback: catch unique violation on email (23505) as a safety net
    // in case the dedup check was skipped or a race condition occurred.
    if (err.code === "23505" && err.constraint?.includes("email")) {
      throw new AppError(
        409,
        `A contact with email "${normalizedEmail}" already exists`,
        "DUPLICATE_EMAIL"
      );
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
  if (input.phone !== undefined) updates.phone = input.phone?.trim() || null;
  if (input.mobile !== undefined) updates.mobile = input.mobile?.trim() || null;
  if (input.companyName !== undefined) updates.companyName = input.companyName?.trim() || null;
  if (input.jobTitle !== undefined) updates.jobTitle = input.jobTitle?.trim() || null;
  if (input.category !== undefined) updates.category = input.category;
  if (input.address !== undefined) updates.address = input.address?.trim() || null;
  if (input.city !== undefined) updates.city = input.city?.trim() || null;
  if (input.state !== undefined) updates.state = input.state?.trim() || null;
  if (input.zip !== undefined) updates.zip = input.zip?.trim() || null;
  if (input.notes !== undefined) updates.notes = input.notes?.trim() || null;

  if (Object.keys(updates).length === 0) {
    return existing;
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

  const result = await tenantDb
    .update(contacts)
    .set({ isActive: false })
    .where(eq(contacts.id, contactId))
    .returning();

  if (result.length === 0) {
    throw new AppError(404, "Contact not found");
  }

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
 * Get distinct company names for filter dropdowns.
 */
export async function getCompanyNames(tenantDb: TenantDb) {
  const result = await tenantDb
    .selectDistinct({ companyName: contacts.companyName })
    .from(contacts)
    .where(and(eq(contacts.isActive, true), not(isNull(contacts.companyName))))
    .orderBy(asc(contacts.companyName));

  return result.map((r) => r.companyName).filter(Boolean) as string[];
}
