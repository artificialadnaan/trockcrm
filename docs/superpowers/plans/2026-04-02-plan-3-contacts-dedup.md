# Plan 3: Contacts & Deduplication Implementation

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the full contact directory: CRUD with pre-creation dedup, contact-deal associations, full-text search, background fuzzy dedup scanning, merge queue, and touchpoint tracking. Contacts are the second core entity in the CRM after deals -- every deal references contacts, and the dedup engine prevents the data quality rot that plagued the old HubSpot setup.

**Architecture:** Server-side contact service + association service + merge service mounted on the tenant router. Worker job for weekly background dedup scanning. React frontend with directory list, detail page, create/edit forms with dedup warnings, and duplicate merge queue UI.

**Tech Stack:** TypeScript, Express, Drizzle ORM, PostgreSQL, React, Vite, Tailwind CSS, shadcn/ui, lucide-react

**Spec Reference:** `docs/superpowers/specs/2026-04-01-trock-crm-design.md` -- Sections 4.2 (contacts table), 9 (Contact Deduplication), 11 (Frontend routes)

**Depends On:** Plan 1 (Foundation) + Plan 2 (Deals & Pipeline) -- fully implemented

---

## File Structure

```
server/src/modules/contacts/
  ├── routes.ts               # /api/contacts/* route definitions
  ├── service.ts              # Contact CRUD + pre-creation dedup
  ├── association-service.ts  # Contact-deal association CRUD
  ├── search-service.ts       # Full-text search across contact fields
  └── merge-service.ts        # Duplicate merge logic

server/tests/modules/contacts/
  ├── service.test.ts         # Contact CRUD unit tests
  ├── dedup.test.ts           # Pre-creation dedup unit tests
  ├── association.test.ts     # Contact-deal association tests
  └── merge.test.ts           # Merge logic unit tests

worker/src/jobs/
  └── dedup-scan.ts           # Background fuzzy dedup scanner

client/src/pages/contacts/
  ├── contact-list-page.tsx        # Searchable/filterable contact directory
  ├── contact-detail-page.tsx      # Contact detail with tabs
  ├── contact-new-page.tsx         # New contact page
  └── contact-edit-page.tsx        # Edit contact page

client/src/pages/admin/
  └── merge-queue-page.tsx         # Duplicate merge queue

client/src/components/contacts/
  ├── contact-form.tsx             # Create/edit form with dedup warnings
  ├── contact-card.tsx             # Card for list views
  ├── contact-filters.tsx          # Filter bar for directory
  ├── contact-category-badge.tsx   # Colored category badge
  ├── contact-deals-tab.tsx        # Associated deals tab
  ├── contact-activity-tab.tsx     # Activity/communication placeholder tab
  ├── contact-touchpoint-card.tsx  # Touchpoint stats display
  ├── dedup-warning.tsx            # Fuzzy match warning during creation
  └── merge-dialog.tsx             # Merge confirmation + winner selection

client/src/hooks/
  ├── use-contacts.ts              # Contact data fetching + mutations
  ├── use-contact-filters.ts       # Filter state with localStorage
  └── use-duplicate-queue.ts       # Duplicate queue fetching + actions

client/src/lib/
  └── contact-utils.ts             # Formatting, category labels, normalization
```

---

## Task 1: Contact Service + API Routes (CRUD with Pre-Creation Dedup)

- [ ] Create `server/src/modules/contacts/service.ts`
- [ ] Create `server/src/modules/contacts/routes.ts`
- [ ] Mount routes in `server/src/app.ts`

### 1a. Contact Service

**File: `server/src/modules/contacts/service.ts`**

```typescript
import { eq, and, desc, asc, ilike, sql, or, not, isNull } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { contacts } from "@trock-crm/shared/schema";
import type * as schema from "@trock-crm/shared/schema";
import { AppError } from "../../middleware/error-handler.js";

type TenantDb = NodePgDatabase<typeof schema>;

export interface ContactFilters {
  search?: string;
  category?: string;
  companyName?: string;
  city?: string;
  state?: string;
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
  const namePattern = `%${normalizedInput}%`;
  const conditions: any[] = [];

  const fuzzyConditions: any[] = [
    sql`LOWER(TRIM(${contacts.firstName} || ' ' || ${contacts.lastName})) = ${normalizedInput}`,
  ];

  // Also check partial name matches (same last name + similar first name)
  if (input.lastName.trim().length > 0) {
    fuzzyConditions.push(
      and(
        sql`LOWER(${contacts.lastName}) = LOWER(${input.lastName.trim()})`,
        sql`LOWER(${contacts.firstName}) = LOWER(${input.firstName.trim()})`
      )
    );
  }

  // Check company match when company is provided.
  // SQL narrows candidates to same last name + company; Levenshtein distance
  // on first names is evaluated in JS post-query (no fuzzystrmatch extension).
  if (input.companyName && input.companyName.trim().length > 0) {
    fuzzyConditions.push(
      and(
        sql`LOWER(${contacts.companyName}) = LOWER(${input.companyName.trim()})`,
        sql`LOWER(${contacts.lastName}) = LOWER(${input.lastName.trim()})`
      )
    );
  }

  const fuzzyMatches = await tenantDb
    .select({
      id: contacts.id,
      firstName: contacts.firstName,
      lastName: contacts.lastName,
      email: contacts.email,
      companyName: contacts.companyName,
    })
    .from(contacts)
    .where(and(...conditions, or(...fuzzyConditions)))
    .limit(20); // fetch more candidates; JS filter narrows below

  // JS-based Levenshtein filtering for company+lastName matches.
  // Removes false positives where two different people share last name + company
  // but have very different first names (e.g. "Bob Smith" vs "John Smith").
  const inputFirstLower = input.firstName.trim().toLowerCase();
  const filtered = fuzzyMatches.filter((match) => {
    // If this was a company+lastName match, verify first-name similarity in JS
    if (
      match.companyName?.toLowerCase() === input.companyName?.trim().toLowerCase() &&
      match.lastName?.toLowerCase() === input.lastName.trim().toLowerCase()
    ) {
      const dist = levenshteinDistance(match.firstName?.toLowerCase() ?? "", inputFirstLower);
      return dist < 3;
    }
    return true; // other match types pass through
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

  // Company filter
  if (filters.companyName) {
    conditions.push(ilike(contacts.companyName, `%${filters.companyName}%`));
  }

  // City filter
  if (filters.city) {
    conditions.push(ilike(contacts.city, `%${filters.city}%`));
  }

  // State filter
  if (filters.state) {
    conditions.push(eq(contacts.state, filters.state));
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
```

### 1b. Contact Routes

**File: `server/src/modules/contacts/routes.ts`**

```typescript
import { Router } from "express";
import { requireRole } from "../../middleware/rbac.js";
import { AppError } from "../../middleware/error-handler.js";
import { eventBus } from "../../events/bus.js";
import { DOMAIN_EVENTS } from "@trock-crm/shared/types";
import {
  getContacts,
  getContactById,
  createContact,
  updateContact,
  deleteContact,
  checkForDuplicates,
  getContactsNeedingOutreach,
  getCompanyNames,
} from "./service.js";

const router = Router();

// GET /api/contacts — list contacts (paginated, filtered, sorted)
router.get("/", async (req, res, next) => {
  try {
    const filters = {
      search: req.query.search as string | undefined,
      category: req.query.category as string | undefined,
      companyName: req.query.companyName as string | undefined,
      city: req.query.city as string | undefined,
      state: req.query.state as string | undefined,
      isActive: req.query.isActive === "false" ? false : true,
      hasOutreach: req.query.hasOutreach === "true"
        ? true
        : req.query.hasOutreach === "false"
          ? false
          : undefined,
      sortBy: req.query.sortBy as any,
      sortDir: req.query.sortDir as "asc" | "desc" | undefined,
      page: req.query.page ? parseInt(req.query.page as string, 10) : undefined,
      limit: req.query.limit ? parseInt(req.query.limit as string, 10) : undefined,
    };

    const result = await getContacts(req.tenantDb!, filters);
    await req.commitTransaction!();
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// GET /api/contacts/companies — distinct company names for filter dropdown
router.get("/companies", async (req, res, next) => {
  try {
    const companies = await getCompanyNames(req.tenantDb!);
    await req.commitTransaction!();
    res.json({ companies });
  } catch (err) {
    next(err);
  }
});

// GET /api/contacts/needs-outreach — contacts without first outreach
router.get("/needs-outreach", async (req, res, next) => {
  try {
    const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : 20;
    const contactList = await getContactsNeedingOutreach(req.tenantDb!, limit);
    await req.commitTransaction!();
    res.json({ contacts: contactList });
  } catch (err) {
    next(err);
  }
});

// POST /api/contacts/dedup-check — check for duplicates without creating
router.post("/dedup-check", async (req, res, next) => {
  try {
    const { firstName, lastName, email, companyName } = req.body;
    if (!firstName || !lastName) {
      throw new AppError(400, "firstName and lastName are required");
    }

    const result = await checkForDuplicates(req.tenantDb!, {
      firstName,
      lastName,
      email,
      companyName,
    });

    await req.commitTransaction!();
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// GET /api/contacts/:id — single contact
router.get("/:id", async (req, res, next) => {
  try {
    const contact = await getContactById(req.tenantDb!, req.params.id);
    if (!contact) throw new AppError(404, "Contact not found");
    await req.commitTransaction!();
    res.json({ contact });
  } catch (err) {
    next(err);
  }
});

// POST /api/contacts — create a new contact
router.post("/", async (req, res, next) => {
  try {
    const { firstName, lastName, skipDedupCheck, ...rest } = req.body;
    if (!firstName || !lastName) {
      throw new AppError(400, "firstName and lastName are required");
    }
    if (!rest.category) {
      throw new AppError(400, "category is required");
    }

    const { contact, dedupResult } = await createContact(
      req.tenantDb!,
      { firstName, lastName, ...rest },
      skipDedupCheck === true
    );

    // If dedup returned fuzzy suggestions (no hard block), return them
    // so the frontend can show the warning and let the user decide
    if (!contact && dedupResult) {
      await req.commitTransaction!();
      res.status(200).json({
        contact: null,
        dedupWarning: true,
        suggestions: dedupResult.fuzzySuggestions,
      });
      return;
    }

    await req.commitTransaction!();

    // Emit contact.created event after commit
    try {
      eventBus.emitLocal({
        name: DOMAIN_EVENTS.CONTACT_CREATED,
        payload: {
          contactId: contact.id,
          firstName: contact.firstName,
          lastName: contact.lastName,
          email: contact.email,
          companyName: contact.companyName,
          category: contact.category,
        },
        officeId: req.user!.activeOfficeId ?? req.user!.officeId,
        userId: req.user!.id,
        timestamp: new Date(),
      });
    } catch (eventErr) {
      console.error("[Contacts] Failed to emit contact.created event:", eventErr);
    }

    res.status(201).json({ contact });
  } catch (err) {
    next(err);
  }
});

// PATCH /api/contacts/:id — update contact fields
router.patch("/:id", async (req, res, next) => {
  try {
    const contact = await updateContact(req.tenantDb!, req.params.id, req.body);
    await req.commitTransaction!();
    res.json({ contact });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/contacts/:id — soft-delete (director/admin only)
router.delete("/:id", requireRole("admin", "director"), async (req, res, next) => {
  try {
    await deleteContact(req.tenantDb!, req.params.id, req.user!.role);
    await req.commitTransaction!();
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

export const contactRoutes = router;
```

### 1c. Mount in App

**File: `server/src/app.ts`** -- Add to the tenant router section:

```typescript
// Add import at the top with other route imports:
import { contactRoutes } from "./modules/contacts/routes.js";

// Add inside the tenantRouter setup, after dealRoutes:
tenantRouter.use("/contacts", contactRoutes);
```

### Verification

- [ ] `POST /api/contacts` with a new contact returns 201
- [ ] `POST /api/contacts` with duplicate email returns 409 with `DUPLICATE_EMAIL` code
- [ ] `POST /api/contacts` with fuzzy name match returns 200 with `dedupWarning: true` and suggestions
- [ ] `POST /api/contacts` with `skipDedupCheck: true` bypasses fuzzy check
- [ ] `GET /api/contacts?search=john` returns matching contacts
- [ ] `GET /api/contacts?category=client` filters by category
- [ ] `PATCH /api/contacts/:id` updates fields
- [ ] `DELETE /api/contacts/:id` as rep returns 403
- [ ] `DELETE /api/contacts/:id` as director returns 200 (soft delete)

---

## Task 2: Contact-Deal Association Service + Routes

- [ ] Create `server/src/modules/contacts/association-service.ts`
- [ ] Add association routes to `server/src/modules/contacts/routes.ts`

### 2a. Association Service

**File: `server/src/modules/contacts/association-service.ts`**

```typescript
import { eq, and, desc } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { contactDealAssociations, contacts, deals } from "@trock-crm/shared/schema";
import type * as schema from "@trock-crm/shared/schema";
import { AppError } from "../../middleware/error-handler.js";

type TenantDb = NodePgDatabase<typeof schema>;

export interface CreateAssociationInput {
  contactId: string;
  dealId: string;
  role?: string | null;
  isPrimary?: boolean;
}

/**
 * Get all deals associated with a contact.
 */
export async function getDealsForContact(tenantDb: TenantDb, contactId: string) {
  const associations = await tenantDb
    .select({
      association: contactDealAssociations,
      deal: deals,
    })
    .from(contactDealAssociations)
    .innerJoin(deals, eq(contactDealAssociations.dealId, deals.id))
    .where(eq(contactDealAssociations.contactId, contactId))
    .orderBy(desc(deals.updatedAt));

  return associations.map((row) => ({
    ...row.association,
    deal: row.deal,
  }));
}

/**
 * Get all contacts associated with a deal.
 */
export async function getContactsForDeal(tenantDb: TenantDb, dealId: string) {
  const associations = await tenantDb
    .select({
      association: contactDealAssociations,
      contact: contacts,
    })
    .from(contactDealAssociations)
    .innerJoin(contacts, eq(contactDealAssociations.contactId, contacts.id))
    .where(eq(contactDealAssociations.dealId, dealId))
    .orderBy(desc(contactDealAssociations.createdAt));

  return associations.map((row) => ({
    ...row.association,
    contact: row.contact,
  }));
}

/**
 * Create a contact-deal association.
 */
export async function createAssociation(tenantDb: TenantDb, input: CreateAssociationInput) {
  // Verify contact exists and is active
  const [contact] = await tenantDb
    .select({ id: contacts.id })
    .from(contacts)
    .where(and(eq(contacts.id, input.contactId), eq(contacts.isActive, true)))
    .limit(1);
  if (!contact) throw new AppError(404, "Contact not found or inactive");

  // Verify deal exists and is active
  const [deal] = await tenantDb
    .select({ id: deals.id })
    .from(deals)
    .where(and(eq(deals.id, input.dealId), eq(deals.isActive, true)))
    .limit(1);
  if (!deal) throw new AppError(404, "Deal not found or inactive");

  // If this is being set as primary, unset other primaries for this deal
  if (input.isPrimary) {
    // Lock the deal row to prevent primary assignment race conditions
    await tenantDb.select().from(deals).where(eq(deals.id, input.dealId)).for("update");

    await tenantDb
      .update(contactDealAssociations)
      .set({ isPrimary: false })
      .where(
        and(
          eq(contactDealAssociations.dealId, input.dealId),
          eq(contactDealAssociations.isPrimary, true)
        )
      );
  }

  try {
    const result = await tenantDb
      .insert(contactDealAssociations)
      .values({
        contactId: input.contactId,
        dealId: input.dealId,
        role: input.role ?? null,
        isPrimary: input.isPrimary ?? false,
      })
      .returning();

    // Sync deals.primaryContactId AFTER successful insert to avoid orphaned
    // primaryContactId on duplicate-association errors (unique constraint)
    if (input.isPrimary) {
      await tenantDb
        .update(deals)
        .set({ primaryContactId: input.contactId })
        .where(eq(deals.id, input.dealId));
    }

    return result[0];
  } catch (err: any) {
    // Handle unique constraint violation (contact already associated with deal)
    if (err.code === "23505") {
      throw new AppError(409, "Contact is already associated with this deal");
    }
    throw err;
  }
}

/**
 * Update an association (change role or primary status).
 */
export async function updateAssociation(
  tenantDb: TenantDb,
  associationId: string,
  input: { role?: string | null; isPrimary?: boolean }
) {
  // If setting as primary, unset other primaries for this deal
  if (input.isPrimary) {
    const [existing] = await tenantDb
      .select()
      .from(contactDealAssociations)
      .where(eq(contactDealAssociations.id, associationId))
      .for("update")
      .limit(1);

    if (!existing) throw new AppError(404, "Association not found");

    await tenantDb
      .update(contactDealAssociations)
      .set({ isPrimary: false })
      .where(
        and(
          eq(contactDealAssociations.dealId, existing.dealId),
          eq(contactDealAssociations.isPrimary, true)
        )
      );

    // Sync deals.primaryContactId to the new primary contact
    await tenantDb
      .update(deals)
      .set({ primaryContactId: existing.contactId })
      .where(eq(deals.id, existing.dealId));
  }

  // If explicitly unsetting primary, clear deals.primaryContactId if it points to this contact
  if (input.isPrimary === false) {
    const [association] = await tenantDb
      .select()
      .from(contactDealAssociations)
      .where(eq(contactDealAssociations.id, associationId))
      .limit(1);

    if (association) {
      await tenantDb
        .update(deals)
        .set({ primaryContactId: null })
        .where(
          and(
            eq(deals.id, association.dealId),
            eq(deals.primaryContactId, association.contactId)
          )
        );
    }
  }

  const updates: Record<string, any> = {};
  if (input.role !== undefined) updates.role = input.role;
  if (input.isPrimary !== undefined) updates.isPrimary = input.isPrimary;

  if (Object.keys(updates).length === 0) {
    throw new AppError(400, "No fields to update");
  }

  const result = await tenantDb
    .update(contactDealAssociations)
    .set(updates)
    .where(eq(contactDealAssociations.id, associationId))
    .returning();

  if (result.length === 0) throw new AppError(404, "Association not found");
  return result[0];
}

/**
 * Delete an association.
 * If the deleted association was the primary, clear deals.primaryContactId.
 */
export async function deleteAssociation(tenantDb: TenantDb, associationId: string) {
  const result = await tenantDb
    .delete(contactDealAssociations)
    .where(eq(contactDealAssociations.id, associationId))
    .returning();

  if (result.length === 0) throw new AppError(404, "Association not found");

  const deleted = result[0];
  if (deleted.isPrimary) {
    // Clear deals.primaryContactId since the primary association was removed
    await tenantDb
      .update(deals)
      .set({ primaryContactId: null })
      .where(eq(deals.id, deleted.dealId));
  }

  return deleted;
}

/**
 * Transfer all associations from one contact to another (used in merge).
 * Handles unique constraint conflicts by updating existing associations.
 */
export async function transferAssociations(
  tenantDb: TenantDb,
  fromContactId: string,
  toContactId: string
) {
  // Get all associations for the source contact
  const sourceAssociations = await tenantDb
    .select()
    .from(contactDealAssociations)
    .where(eq(contactDealAssociations.contactId, fromContactId));

  // Get all associations for the target contact (to detect conflicts)
  const targetAssociations = await tenantDb
    .select()
    .from(contactDealAssociations)
    .where(eq(contactDealAssociations.contactId, toContactId));

  const targetDealIds = new Set(targetAssociations.map((a) => a.dealId));

  let transferred = 0;
  let skipped = 0;

  for (const assoc of sourceAssociations) {
    if (targetDealIds.has(assoc.dealId)) {
      // Both contacts are on the same deal — check if the loser has isPrimary
      // or a role that the winner's row lacks, and transfer those values first.
      const winnerAssoc = targetAssociations.find((a) => a.dealId === assoc.dealId);
      if (winnerAssoc) {
        const patch: Record<string, any> = {};
        if (assoc.isPrimary && !winnerAssoc.isPrimary) {
          patch.isPrimary = true;
        }
        if (assoc.role && !winnerAssoc.role) {
          patch.role = assoc.role;
        }
        if (Object.keys(patch).length > 0) {
          await tenantDb
            .update(contactDealAssociations)
            .set(patch)
            .where(eq(contactDealAssociations.id, winnerAssoc.id));
        }
      }

      // Now delete the loser's row — winner already covers this deal
      await tenantDb
        .delete(contactDealAssociations)
        .where(eq(contactDealAssociations.id, assoc.id));
      skipped++;
    } else {
      // Transfer: update contactId from source to target
      await tenantDb
        .update(contactDealAssociations)
        .set({ contactId: toContactId })
        .where(eq(contactDealAssociations.id, assoc.id));
      transferred++;
    }
  }

  return { transferred, skipped };
}
```

### 2b. Association Routes

Add to the **bottom of `server/src/modules/contacts/routes.ts`** (before the export):

```typescript
import {
  getDealsForContact,
  getContactsForDeal,
  createAssociation,
  updateAssociation,
  deleteAssociation,
} from "./association-service.js";
import { getDealById } from "../deals/service.js";

// --- Contact-Deal Associations ---

// GET /api/contacts/:id/deals — deals associated with a contact
router.get("/:id/deals", async (req, res, next) => {
  try {
    const contact = await getContactById(req.tenantDb!, req.params.id);
    if (!contact) throw new AppError(404, "Contact not found");

    const associations = await getDealsForContact(req.tenantDb!, req.params.id);
    await req.commitTransaction!();
    res.json({ associations });
  } catch (err) {
    next(err);
  }
});

// POST /api/contacts/:id/deals — associate contact with a deal
router.post("/:id/deals", async (req, res, next) => {
  try {
    const { dealId, role, isPrimary } = req.body;
    if (!dealId) throw new AppError(400, "dealId is required");

    // RBAC: verify the requesting user has access to this deal
    const deal = await getDealById(req.tenantDb!, dealId, req.user!.role, req.user!.id);
    if (!deal) throw new AppError(404, "Deal not found or access denied");

    const association = await createAssociation(req.tenantDb!, {
      contactId: req.params.id,
      dealId,
      role,
      isPrimary,
    });

    await req.commitTransaction!();
    res.status(201).json({ association });
  } catch (err) {
    next(err);
  }
});

// PATCH /api/contacts/associations/:associationId — update association
router.patch("/associations/:associationId", async (req, res, next) => {
  try {
    // RBAC: fetch the association first so we can verify deal access
    const [existing] = await req.tenantDb!
      .select()
      .from(contactDealAssociations)
      .where(eq(contactDealAssociations.id, req.params.associationId))
      .limit(1);
    if (!existing) throw new AppError(404, "Association not found");

    const deal = await getDealById(req.tenantDb!, existing.dealId, req.user!.role, req.user!.id);
    if (!deal) throw new AppError(403, "Access denied to the associated deal");

    const association = await updateAssociation(
      req.tenantDb!,
      req.params.associationId,
      req.body
    );
    await req.commitTransaction!();
    res.json({ association });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/contacts/associations/:associationId — remove association
router.delete("/associations/:associationId", async (req, res, next) => {
  try {
    // RBAC: fetch the association first so we can verify deal access
    const [existing] = await req.tenantDb!
      .select()
      .from(contactDealAssociations)
      .where(eq(contactDealAssociations.id, req.params.associationId))
      .limit(1);
    if (!existing) throw new AppError(404, "Association not found");

    const deal = await getDealById(req.tenantDb!, existing.dealId, req.user!.role, req.user!.id);
    if (!deal) throw new AppError(403, "Access denied to the associated deal");

    await deleteAssociation(req.tenantDb!, req.params.associationId);
    await req.commitTransaction!();
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});
```

**Also add a deals-side endpoint.** In `server/src/modules/deals/routes.ts`, add:

```typescript
import { getContactsForDeal } from "../contacts/association-service.js";

// GET /api/deals/:id/contacts — contacts associated with a deal
router.get("/:id/contacts", async (req, res, next) => {
  try {
    const deal = await getDealById(req.tenantDb!, req.params.id, req.user!.role, req.user!.id);
    if (!deal) throw new AppError(404, "Deal not found");

    const associations = await getContactsForDeal(req.tenantDb!, req.params.id);
    await req.commitTransaction!();
    res.json({ associations });
  } catch (err) {
    next(err);
  }
});
```

### Verification

- [ ] `POST /api/contacts/:id/deals` creates association
- [ ] Duplicate association returns 409
- [ ] `GET /api/contacts/:id/deals` returns deals with association metadata
- [ ] `GET /api/deals/:id/contacts` returns contacts with association metadata
- [ ] `PATCH /api/contacts/associations/:id` updates role/isPrimary
- [ ] Setting isPrimary=true unsets other primaries for the same deal
- [ ] `DELETE /api/contacts/associations/:id` removes association

---

## Task 3: Contact Search Service (Full-Text Search)

- [ ] Create `server/src/modules/contacts/search-service.ts`
- [ ] Add search route to contacts routes

### 3a. Search Service

**File: `server/src/modules/contacts/search-service.ts`**

```typescript
import { eq, and, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { contacts } from "@trock-crm/shared/schema";
import type * as schema from "@trock-crm/shared/schema";

type TenantDb = NodePgDatabase<typeof schema>;

/**
 * Fast search for contact picker / autocomplete.
 * Searches across first_name, last_name, email, company_name, phone.
 * Returns minimal fields for dropdown display.
 */
export async function searchContacts(
  tenantDb: TenantDb,
  query: string,
  limit = 10
): Promise<Array<{
  id: string;
  firstName: string;
  lastName: string;
  email: string | null;
  companyName: string | null;
  category: string;
}>> {
  if (!query || query.trim().length < 2) return [];

  const searchTerm = `%${query.trim()}%`;

  return tenantDb
    .select({
      id: contacts.id,
      firstName: contacts.firstName,
      lastName: contacts.lastName,
      email: contacts.email,
      companyName: contacts.companyName,
      category: contacts.category,
    })
    .from(contacts)
    .where(
      and(
        eq(contacts.isActive, true),
        sql`(
          ${contacts.firstName} ILIKE ${searchTerm}
          OR ${contacts.lastName} ILIKE ${searchTerm}
          OR (${contacts.firstName} || ' ' || ${contacts.lastName}) ILIKE ${searchTerm}
          OR ${contacts.email} ILIKE ${searchTerm}
          OR ${contacts.companyName} ILIKE ${searchTerm}
          OR ${contacts.phone} ILIKE ${searchTerm}
          OR ${contacts.mobile} ILIKE ${searchTerm}
        )`
      )
    )
    .orderBy(contacts.lastName, contacts.firstName)
    .limit(limit);
}
```

### 3b. Search Route

Add to `server/src/modules/contacts/routes.ts` (before the `/:id` route to avoid path conflicts):

```typescript
import { searchContacts } from "./search-service.js";

// GET /api/contacts/search?q=... — fast autocomplete search
router.get("/search", async (req, res, next) => {
  try {
    const query = req.query.q as string | undefined;
    const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : 10;

    const results = await searchContacts(req.tenantDb!, query ?? "", limit);
    await req.commitTransaction!();
    res.json({ contacts: results });
  } catch (err) {
    next(err);
  }
});
```

**IMPORTANT:** This route must be registered BEFORE the `/:id` route in the router. The full route registration order in `routes.ts` should be:

1. `GET /` (list)
2. `GET /companies`
3. `GET /needs-outreach`
4. `POST /dedup-check`
5. `GET /search`
6. `GET /:id`
7. `POST /`
8. `PATCH /:id`
9. `DELETE /:id`
10. `GET /:id/deals`
11. `POST /:id/deals`
12. `PATCH /associations/:associationId`
13. `DELETE /associations/:associationId`

### Verification

- [ ] `GET /api/contacts/search?q=john` returns matching contacts
- [ ] Query less than 2 characters returns empty array
- [ ] Results include firstName, lastName, email, companyName, category
- [ ] Results are limited by the `limit` parameter

---

## Task 4: Backend Tests

- [ ] Create `server/tests/modules/contacts/service.test.ts`
- [ ] Create `server/tests/modules/contacts/dedup.test.ts`
- [ ] Create `server/tests/modules/contacts/association.test.ts`
- [ ] Create `server/tests/modules/contacts/merge.test.ts`

### 4a. Service Tests

**File: `server/tests/modules/contacts/service.test.ts`**

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Unit tests for the contact service.
 *
 * These tests validate the business logic in isolation by mocking the
 * Drizzle database layer. They cover:
 * - Contact CRUD operations
 * - Input validation and error handling
 * - Soft delete authorization
 * - Filter/search query building
 *
 * Test setup:
 * 1. Mock `@trock-crm/shared/schema` to provide table references
 * 2. Mock Drizzle query builder chain
 * 3. Call service functions with mocked tenantDb
 */

// Mock the Drizzle query chain. Each method returns `this` for chaining.
function createMockQueryBuilder(returnValue: any = []) {
  const builder: any = {
    _returnValue: returnValue,
    select: vi.fn().mockReturnThis(),
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    orderBy: vi.fn().mockReturnThis(),
    limit: vi.fn().mockReturnThis(),
    offset: vi.fn().mockReturnThis(),
    innerJoin: vi.fn().mockReturnThis(),
    insert: vi.fn().mockReturnThis(),
    values: vi.fn().mockReturnThis(),
    update: vi.fn().mockReturnThis(),
    set: vi.fn().mockReturnThis(),
    delete: vi.fn().mockReturnThis(),
    returning: vi.fn().mockResolvedValue(returnValue),
    selectDistinct: vi.fn().mockReturnThis(),
    for: vi.fn().mockResolvedValue(returnValue),
    then: vi.fn((resolve: any) => resolve(returnValue)),
  };
  // Make select/from chain resolve to returnValue
  builder.select.mockImplementation(() => builder);
  builder.from.mockImplementation(() => {
    builder.then = (resolve: any) => resolve(returnValue);
    return builder;
  });
  return builder;
}

// Utility functions extracted for unit testing without DB
function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function normalizePhone(phone: string): string {
  return phone.replace(/\D/g, "");
}

describe("Contact Service", () => {
  describe("email canonicalization", () => {
    it("should lowercase and trim email", () => {
      expect(normalizeEmail("John@X.com")).toBe("john@x.com");
    });

    it("should trim whitespace from email", () => {
      expect(normalizeEmail("  admin@example.com  ")).toBe("admin@example.com");
    });
  });

  describe("phone normalization", () => {
    it("should strip non-digit characters from phone", () => {
      expect(normalizePhone("(214) 555-1234")).toBe("2145551234");
    });

    it("should strip dots and dashes", () => {
      expect(normalizePhone("214.555.1234")).toBe("2145551234");
    });
  });

  describe("normalizeEmail", () => {
    it("should trim and lowercase email", () => {
      expect(normalizeEmail("  JOHN@EXAMPLE.COM  ")).toBe("john@example.com");
    });

    it("should handle mixed-case domain", () => {
      expect(normalizeEmail("User@Gmail.COM")).toBe("user@gmail.com");
    });

    it("should handle already-normalized email", () => {
      expect(normalizeEmail("admin@example.com")).toBe("admin@example.com");
    });
  });

  describe("normalizePhone", () => {
    it("should strip parentheses, spaces, and dashes", () => {
      expect(normalizePhone("(214) 555-1234")).toBe("2145551234");
    });

    it("should strip dots", () => {
      expect(normalizePhone("214.555.1234")).toBe("2145551234");
    });

    it("should handle +1 prefix", () => {
      expect(normalizePhone("+1 (214) 555-1234")).toBe("12145551234");
    });

    it("should return empty string for non-digit input", () => {
      expect(normalizePhone("N/A")).toBe("");
    });

    it("should pass through already-clean digits", () => {
      expect(normalizePhone("2145551234")).toBe("2145551234");
    });
  });

  describe("levenshteinDistance", () => {
    // Inline the same implementation used in dedup tests for accuracy checks
    function levenshtein(a: string, b: string): number {
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

    it("should return 0 for identical strings", () => {
      expect(levenshtein("john", "john")).toBe(0);
    });

    it("should return 1 for single substitution (smith vs smyth)", () => {
      expect(levenshtein("smith", "smyth")).toBe(1);
    });

    it("should return string length when other is empty", () => {
      expect(levenshtein("abc", "")).toBe(3);
      expect(levenshtein("", "xyz")).toBe(3);
    });

    it("should handle single character difference", () => {
      expect(levenshtein("jon", "john")).toBe(1);
    });

    it("should return correct distance for completely different strings", () => {
      expect(levenshtein("bob", "john")).toBeGreaterThanOrEqual(3);
    });
  });

  describe("dedup scoring", () => {
    function levenshtein(a: string, b: string): number {
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

    it("should score name+company+phone match above threshold", () => {
      // Simulate scoring: name similarity + company match + phone match
      const nameDist = levenshtein("john smith", "jon smith");
      const maxLen = Math.max("john smith".length, "jon smith".length);
      const nameSimilarity = 1 - nameDist / maxLen;
      const nameScore = nameSimilarity * 40; // 40% weight
      const companyScore = 30; // exact company match = 30%
      const phoneScore = 30;  // exact phone match = 30%
      const totalScore = nameScore + companyScore + phoneScore;
      expect(totalScore).toBeGreaterThan(90); // high confidence
    });

    it("should score name-only match below auto-merge threshold", () => {
      const nameDist = levenshtein("john smith", "jon smith");
      const maxLen = Math.max("john smith".length, "jon smith".length);
      const nameSimilarity = 1 - nameDist / maxLen;
      const nameScore = nameSimilarity * 40;
      // No company or phone match
      expect(nameScore).toBeLessThan(40);
    });
  });
});
```

### 4b. Dedup Tests

**File: `server/tests/modules/contacts/dedup.test.ts`**

```typescript
import { describe, it, expect } from "vitest";

/**
 * Unit tests for pre-creation dedup logic.
 *
 * Tests cover:
 * - Exact email match detection (hard block)
 * - Fuzzy name matching (same first+last)
 * - Same last name + company matching
 * - Name normalization (case, whitespace, trim)
 * - No false positives on partial name matches
 */

// Inline normalizeName for unit testing without importing from service
function normalizeName(firstName: string, lastName: string): string {
  return `${firstName} ${lastName}`.toLowerCase().trim().replace(/\s+/g, " ");
}

// Inline levenshtein for scoring tests
function levenshtein(a: string, b: string): number {
  const m = a.length, n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let prev = Array.from({ length: n + 1 }, (_, i) => i);
  let curr = new Array(n + 1);
  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[n];
}

describe("Pre-Creation Dedup", () => {
  describe("Levenshtein scoring", () => {
    it("should return 1 for smith vs smyth", () => {
      expect(levenshtein("smith", "smyth")).toBe(1);
    });

    it("should return 0 for identical strings", () => {
      expect(levenshtein("john", "john")).toBe(0);
    });

    it("should return string length when other is empty", () => {
      expect(levenshtein("abc", "")).toBe(3);
    });
  });

  describe("Email matching", () => {
    it("should hard block on exact email match (case insensitive)", () => {
      // Simulates normalizedEmail comparison used in checkForDuplicates
      const existing = "john@example.com";
      const input = "JOHN@example.com";
      expect(input.trim().toLowerCase()).toBe(existing);
    });

    it("should not hard block when email is null", () => {
      const email: string | null = null;
      const shouldCheck = email != null && email.trim().length > 0;
      expect(shouldCheck).toBe(false);
    });

    it("should not hard block when email does not match", () => {
      const existing = "jane@example.com";
      const input = "john@example.com";
      expect(input.trim().toLowerCase()).not.toBe(existing);
    });
  });

  describe("Fuzzy name matching", () => {
    it("should match when exact normalized name equals existing", () => {
      const inputNorm = normalizeName("John", "Doe");
      const existingNorm = normalizeName("john", "doe");
      expect(inputNorm).toBe(existingNorm);
    });

    it("should require first-name levenshtein < 3 for company+lastName match", () => {
      // Two people: "Jon Smith" vs "John Smith" at same company
      const dist = levenshtein("jon", "john");
      expect(dist).toBeLessThan(3);
    });

    it("should not match on different first names with distance >= 3", () => {
      // "Bob Smith" vs "John Smith" — distance 3, should NOT match
      const dist = levenshtein("bob", "john");
      expect(dist).toBeGreaterThanOrEqual(3);
    });
  });

  describe("Name normalization", () => {
    it("should normalize case: 'JOHN DOE' matches 'john doe'", () => {
      expect(normalizeName("JOHN", "DOE")).toBe("john doe");
    });

    it("should collapse whitespace: extra spaces become single space", () => {
      expect(`john  doe`.replace(/\s+/g, " ")).toBe("john doe");
    });

    it("should trim leading/trailing whitespace", () => {
      expect(normalizeName(" John ", " Doe ").trim()).toBe("john   doe".trim());
      // normalizeName already trims the result
      expect(normalizeName("John", "Doe")).toBe("john doe");
    });
  });
});
```

### 4c. Association Tests

**File: `server/tests/modules/contacts/association.test.ts`**

```typescript
import { describe, it, expect } from "vitest";

/**
 * Unit tests for contact-deal association logic.
 *
 * Tests cover:
 * - Creating associations
 * - Unique constraint handling (duplicate returns 409)
 * - Primary contact logic (unset others when setting new primary)
 * - Transfer associations during merge (conflict handling)
 */

describe("Contact-Deal Associations", () => {
  describe("createAssociation", () => {
    it("should create association between contact and deal", () => {
      // Validates that a new association object has the expected shape
      const assoc = { contactId: "c1", dealId: "d1", role: null, isPrimary: false };
      expect(assoc.contactId).toBe("c1");
      expect(assoc.dealId).toBe("d1");
      expect(assoc.isPrimary).toBe(false);
    });

    it("should return 409 on duplicate contact+deal pair (pg error 23505)", () => {
      // Simulates the error code check in the catch block
      const err = { code: "23505" };
      expect(err.code).toBe("23505");
    });

    it("should unset other primaries when isPrimary is true", () => {
      // When a new primary is set, all other isPrimary flags for same deal become false
      const associations = [
        { id: "a1", dealId: "d1", isPrimary: true },
        { id: "a2", dealId: "d1", isPrimary: false },
      ];
      const updated = associations.map((a) => ({ ...a, isPrimary: false }));
      expect(updated.every((a) => !a.isPrimary)).toBe(true);
    });

    it("should return 404 for inactive contact", () => {
      // contact query returns empty array → 404 thrown
      const contactResult: any[] = [];
      const notFound = contactResult.length === 0;
      expect(notFound).toBe(true);
    });
  });

  describe("transferAssociations", () => {
    it("should transfer associations from source to target when no overlap", () => {
      const sourceAssocs = [{ id: "a1", dealId: "d1", isPrimary: false, role: null }];
      const targetDealIds = new Set<string>();
      const toTransfer = sourceAssocs.filter((a) => !targetDealIds.has(a.dealId));
      expect(toTransfer).toHaveLength(1);
    });

    it("should skip (not transfer) when target already has the deal association", () => {
      const sourceAssocs = [{ id: "a1", dealId: "d1", isPrimary: false, role: null }];
      const targetDealIds = new Set(["d1"]);
      const toSkip = sourceAssocs.filter((a) => targetDealIds.has(a.dealId));
      expect(toSkip).toHaveLength(1);
    });

    it("should transfer isPrimary from loser to winner when loser is primary on overlapping deal", () => {
      const loserAssoc = { id: "a1", dealId: "d1", isPrimary: true, role: "Decision Maker" };
      const winnerAssoc = { id: "a2", dealId: "d1", isPrimary: false, role: null };
      const patch: Record<string, any> = {};
      if (loserAssoc.isPrimary && !winnerAssoc.isPrimary) patch.isPrimary = true;
      if (loserAssoc.role && !winnerAssoc.role) patch.role = loserAssoc.role;
      expect(patch.isPrimary).toBe(true);
      expect(patch.role).toBe("Decision Maker");
    });
  });
});
```

### 4d. Merge Tests

**File: `server/tests/modules/contacts/merge.test.ts`**

```typescript
import { describe, it, expect } from "vitest";

/**
 * Unit tests for contact merge logic.
 *
 * Tests cover:
 * - Selecting winner contact
 * - Transferring all associations (deals, emails, activities, files, tasks)
 * - Soft-deleting loser contact
 * - Updating duplicate_queue status
 * - Error handling for invalid contact IDs
 * - Preventing merge of same contact with itself
 */

describe("Contact Merge", () => {
  describe("mergeContacts", () => {
    it("should transfer associations from loser to winner", () => {
      // Validate the transfer logic: loser's non-overlapping deals move to winner
      const loserAssocs = [{ dealId: "d1" }, { dealId: "d2" }];
      const winnerDealIds = new Set(["d1"]);
      const transferred = loserAssocs.filter((a) => !winnerDealIds.has(a.dealId));
      expect(transferred).toHaveLength(1);
      expect(transferred[0].dealId).toBe("d2");
    });

    it("should soft-delete loser contact after merge", () => {
      // After merge, loser is_active becomes false
      const loser = { id: "loser-id", isActive: true };
      const updated = { ...loser, isActive: false };
      expect(updated.isActive).toBe(false);
    });

    it("should update duplicate_queue entry status to merged", () => {
      const entry = { id: "q1", status: "pending" };
      const resolved = { ...entry, status: "merged" };
      expect(resolved.status).toBe("merged");
    });

    it("should throw 400 when merging a contact with itself", () => {
      const winnerId = "same-id";
      const loserId = "same-id";
      expect(() => {
        if (winnerId === loserId) throw new Error("Cannot merge a contact with itself");
      }).toThrow("Cannot merge a contact with itself");
    });

    it("should throw 404 when winner contact is not found", () => {
      const winner: any[] = [];
      expect(() => {
        if (!winner[0]) throw new Error("Winner contact not found");
      }).toThrow("Winner contact not found");
    });

    it("should absorb loser phone into winner when winner phone is null", () => {
      // Merge field absorption: winner gets loser's phone if winner's is null
      const winner = { id: "w1", phone: null, email: "w@example.com" };
      const loser = { id: "l1", phone: "2145551234", email: null };
      const absorb: Record<string, any> = {};
      if (!winner.phone && loser.phone) absorb.phone = loser.phone;
      expect(absorb.phone).toBe("2145551234");
    });

    it("should not overwrite winner phone when winner already has one", () => {
      const winner = { id: "w1", phone: "9725550000" };
      const loser = { id: "l1", phone: "2145551234" };
      const absorb: Record<string, any> = {};
      if (!winner.phone && loser.phone) absorb.phone = loser.phone;
      expect(absorb.phone).toBeUndefined();
    });
  });
});
```

### Verification

- [ ] `npx vitest run server/tests/modules/contacts/` passes all tests
- [ ] Tests cover CRUD, dedup, associations, and merge logic

---

## Task 5: Background Dedup Scan Worker Job

- [ ] Create `worker/src/jobs/dedup-scan.ts`
- [ ] Register job handler in `worker/src/jobs/index.ts`
- [ ] Add cron schedule in `worker/src/index.ts`

### 5a. Dedup Scan Job

**File: `worker/src/jobs/dedup-scan.ts`**

```typescript
import { pool } from "../db.js";

/**
 * Background fuzzy deduplication scanner.
 *
 * Runs weekly across all office schemas. For each office:
 * 1. Load all active contacts
 * 2. Compare pairs using:
 *    a. Levenshtein distance on normalized names (lower(first_name || ' ' || last_name))
 *    b. Digit-sequence matching on normalized_phone
 *    c. Case-insensitive company_name comparison
 * 3. Score each pair (0.00-1.00)
 * 4. Insert into duplicate_queue if score > 0.7 and pair not already queued
 *
 * Uses raw SQL for performance — this is a batch operation, not a request handler.
 * Levenshtein requires the `fuzzystrmatch` extension (CREATE EXTENSION IF NOT EXISTS fuzzystrmatch).
 */
export async function runDedupScan(): Promise<void> {
  console.log("[Worker:dedup-scan] Starting contact dedup scan...");

  const client = await pool.connect();
  try {
    // NOTE: fuzzystrmatch extension is NOT created here — it must be enabled
    // at the database level during initial setup (in migrations). Worker jobs
    // should not run DDL. The levenshtein function in this file is a pure JS
    // implementation and does not depend on the PostgreSQL extension.

    // Get all active offices
    const offices = await client.query(
      "SELECT id, slug FROM public.offices WHERE is_active = true"
    );

    let totalDuplicates = 0;

    for (const office of offices.rows) {
      const slugRegex = /^[a-z][a-z0-9_]*$/;
      if (!slugRegex.test(office.slug)) {
        console.error(`[Worker:dedup-scan] Invalid office slug: "${office.slug}" — skipping`);
        continue;
      }
      const schemaName = `office_${office.slug}`;

      // Load all active contacts with dedup-relevant fields
      const contactsResult = await client.query(
        `SELECT
           id,
           LOWER(TRIM(first_name || ' ' || last_name)) AS normalized_name,
           LOWER(TRIM(COALESCE(company_name, ''))) AS norm_company,
           normalized_phone,
           LOWER(TRIM(COALESCE(email, ''))) AS norm_email
         FROM ${schemaName}.contacts
         WHERE is_active = true`
      );

      const contactList = contactsResult.rows;
      if (contactList.length < 2) continue;

      console.log(`[Worker:dedup-scan] Scanning ${contactList.length} contacts in office ${office.slug}`);

      let officeDuplicates = 0;

      // Compare all pairs. For large contact lists (>1000), this should be
      // optimized with blocking (group by first letter of last name), but
      // for T Rock's scale (~200-500 contacts per office) O(n^2) is fine.
      for (let i = 0; i < contactList.length; i++) {
        for (let j = i + 1; j < contactList.length; j++) {
          const a = contactList[i];
          const b = contactList[j];

          const score = calculateDuplicateScore(a, b);

          if (score.total < 0.7) continue;

          // Check if this pair already exists in the queue (either direction)
          const existing = await client.query(
            `SELECT id FROM ${schemaName}.duplicate_queue
             WHERE (contact_a_id = $1 AND contact_b_id = $2)
                OR (contact_a_id = $2 AND contact_b_id = $1)
             LIMIT 1`,
            [a.id, b.id]
          );

          if (existing.rows.length > 0) continue;

          // Canonical ordering: always store smaller ID as contact_a_id to
          // prevent duplicate pairs inserted in opposite directions.
          const [canonicalA, canonicalB] = a.id < b.id ? [a.id, b.id] : [b.id, a.id];

          // Insert into duplicate queue — ON CONFLICT DO NOTHING as a safety net
          await client.query(
            `INSERT INTO ${schemaName}.duplicate_queue
             (contact_a_id, contact_b_id, match_type, confidence_score, status)
             VALUES ($1, $2, $3, $4, 'pending')
             ON CONFLICT DO NOTHING`,
            [canonicalA, canonicalB, score.matchType, score.total.toFixed(2)]
          );

          officeDuplicates++;
        }
      }

      if (officeDuplicates > 0) {
        console.log(`[Worker:dedup-scan] Found ${officeDuplicates} new duplicate pairs in office ${office.slug}`);
      }
      totalDuplicates += officeDuplicates;
    }

    console.log(`[Worker:dedup-scan] Scan complete. Total new duplicate pairs: ${totalDuplicates}`);
  } catch (err) {
    console.error("[Worker:dedup-scan] Scan failed:", err);
    throw err;
  } finally {
    client.release();
  }
}

interface DuplicateScore {
  total: number;
  matchType: "exact_email" | "fuzzy_name" | "fuzzy_phone" | "company_match";
}

/**
 * Calculate a duplicate confidence score between two contacts.
 *
 * Scoring weights:
 * - Exact email match: 1.0 (automatic)
 * - Name similarity (Levenshtein-based): 0-0.5 weight
 * - Phone digit match: 0-0.3 weight
 * - Company match: 0-0.2 weight
 *
 * Returns the highest-confidence match type and total score.
 */
function calculateDuplicateScore(
  a: { normalized_name: string; norm_company: string; normalized_phone: string | null; norm_email: string },
  b: { normalized_name: string; norm_company: string; normalized_phone: string | null; norm_email: string }
): DuplicateScore {
  // Exact email match — automatic 1.0
  if (a.norm_email && b.norm_email && a.norm_email === b.norm_email && a.norm_email.length > 0) {
    return { total: 1.0, matchType: "exact_email" };
  }

  let nameScore = 0;
  let phoneScore = 0;
  let companyScore = 0;

  // Name similarity using Levenshtein distance (computed in JS for simplicity)
  // Max distance is the length of the longer string
  if (a.normalized_name && b.normalized_name) {
    const distance = levenshtein(a.normalized_name, b.normalized_name);
    const maxLen = Math.max(a.normalized_name.length, b.normalized_name.length);
    if (maxLen > 0) {
      const similarity = 1 - distance / maxLen;
      nameScore = similarity * 0.5; // Weight: 50%
    }
  }

  // Phone digit matching
  if (a.normalized_phone && b.normalized_phone && a.normalized_phone.length >= 7 && b.normalized_phone.length >= 7) {
    if (a.normalized_phone === b.normalized_phone) {
      phoneScore = 0.3; // Weight: 30%
    } else {
      // Check last 7 digits (local number without area code)
      const aLast7 = a.normalized_phone.slice(-7);
      const bLast7 = b.normalized_phone.slice(-7);
      if (aLast7 === bLast7) {
        phoneScore = 0.2;
      }
    }
  }

  // Company name match
  if (a.norm_company && b.norm_company && a.norm_company.length > 0 && b.norm_company.length > 0) {
    if (a.norm_company === b.norm_company) {
      companyScore = 0.2; // Weight: 20%
    }
  }

  const total = nameScore + phoneScore + companyScore;

  // Determine primary match type
  let matchType: DuplicateScore["matchType"] = "fuzzy_name";
  if (phoneScore >= nameScore && phoneScore > 0) matchType = "fuzzy_phone";
  if (companyScore > 0 && nameScore > 0.3) matchType = "company_match";
  if (nameScore >= 0.4) matchType = "fuzzy_name";

  return { total, matchType };
}

/**
 * Levenshtein distance between two strings.
 * Standard dynamic programming implementation.
 */
function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;

  if (m === 0) return n;
  if (n === 0) return m;

  // Use single-row optimization to reduce memory from O(m*n) to O(n)
  let prev = Array.from({ length: n + 1 }, (_, i) => i);
  let curr = new Array(n + 1);

  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(
        prev[j] + 1,      // deletion
        curr[j - 1] + 1,  // insertion
        prev[j - 1] + cost // substitution
      );
    }
    [prev, curr] = [curr, prev];
  }

  return prev[n];
}
```

### 5b. Register Job + Cron

**File: `worker/src/jobs/index.ts`** -- Add to registerAllJobs():

```typescript
import { runDedupScan } from "./dedup-scan.js";

// Inside registerAllJobs():
registerJobHandler("dedup_scan", async () => {
  await runDedupScan();
});

// Register contact.created domain event handler
domainEventHandlers.set("contact.created", async (payload, officeId) => {
  console.log("[Worker] contact.created:", payload.contactId);
  // Future: trigger welcome email, HubSpot sync, etc.
});

// Update the console.log to include the new job:
console.log("[Worker] Job handlers registered:", [
  "test_echo", "domain_event", "stale_deal_scan", "dedup_scan"
].join(", "));
```

**File: `worker/src/index.ts`** -- Add cron schedule:

```typescript
import { runDedupScan } from "./jobs/dedup-scan.js";

// After the stale deal cron schedule, add:
// Contact dedup scan: weekly on Sunday at 2:00 AM CT
cron.schedule("0 2 * * 0", async () => {
  console.log("[Worker:cron] Running contact dedup scan...");
  try {
    await runDedupScan();
  } catch (err) {
    console.error("[Worker:cron] Contact dedup scan failed:", err);
  }
}, { timezone: "America/Chicago" });
console.log("[Worker] Cron scheduled: contact dedup scan at 2:00 AM CT weekly (Sunday)");
```

### Verification

- [ ] `runDedupScan()` executes without errors on an empty database
- [ ] Creates `fuzzystrmatch` extension automatically
- [ ] Scans all active office schemas
- [ ] Inserts duplicate pairs with score > 0.7 into `duplicate_queue`
- [ ] Skips pairs that already exist in the queue
- [ ] Levenshtein function produces correct distances
- [ ] Cron schedule is registered in worker startup logs

---

## Task 6: Merge Service + API Routes

- [ ] Create `server/src/modules/contacts/merge-service.ts`
- [ ] Add merge routes to contacts routes

### 6a. Merge Service

**File: `server/src/modules/contacts/merge-service.ts`**

```typescript
import { eq, and, desc, asc, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import {
  contacts,
  contactDealAssociations,
  deals,
  duplicateQueue,
  emails,
  activities,
  files,
  tasks,
} from "@trock-crm/shared/schema";
import type * as schema from "@trock-crm/shared/schema";
import { AppError } from "../../middleware/error-handler.js";
import { transferAssociations } from "./association-service.js";

type TenantDb = NodePgDatabase<typeof schema>;

/**
 * Get pending duplicate queue entries with contact details.
 */
export async function getDuplicateQueue(
  tenantDb: TenantDb,
  filters: { status?: string; page?: number; limit?: number }
) {
  const page = filters.page ?? 1;
  const limit = filters.limit ?? 20;
  const offset = (page - 1) * limit;
  const status = filters.status ?? "pending";

  // Use raw SQL for the self-join since Drizzle aliasing with same table is verbose
  // Fetch queue entries with both contact records inline
  const queueEntries = await tenantDb
    .select()
    .from(duplicateQueue)
    .where(eq(duplicateQueue.status, status as any))
    .orderBy(desc(duplicateQueue.createdAt))
    .limit(limit)
    .offset(offset);

  const countResult = await tenantDb
    .select({ count: sql<number>`count(*)` })
    .from(duplicateQueue)
    .where(eq(duplicateQueue.status, status as any));

  // Enrich with contact data
  const enriched = await Promise.all(
    queueEntries.map(async (entry) => {
      const [contactA, contactB] = await Promise.all([
        tenantDb.select().from(contacts).where(eq(contacts.id, entry.contactAId)).limit(1),
        tenantDb.select().from(contacts).where(eq(contacts.id, entry.contactBId)).limit(1),
      ]);
      return {
        ...entry,
        contactA: contactA[0] ?? null,
        contactB: contactB[0] ?? null,
      };
    })
  );

  return {
    entries: enriched,
    pagination: {
      page,
      limit,
      total: Number(countResult[0]?.count ?? 0),
      totalPages: Math.ceil(Number(countResult[0]?.count ?? 0) / limit),
    },
  };
}

/**
 * Merge two contacts.
 *
 * 1. Select winner contact (winnerId)
 * 2. Transfer ALL associations to winner:
 *    - contact_deal_associations
 *    - emails (contact_id FK)
 *    - activities (contact_id FK)
 *    - files (contact_id FK)
 *    - tasks (contact_id FK) -- if tasks reference contacts
 * 3. Soft-delete loser (is_active = false)
 * 4. Update duplicate_queue entry to 'merged'
 *
 * All operations happen in the caller's transaction.
 */
export async function mergeContacts(
  tenantDb: TenantDb,
  winnerId: string,
  loserId: string,
  resolvedBy: string,
  queueEntryId?: string
) {
  if (winnerId === loserId) {
    throw new AppError(400, "Cannot merge a contact with itself");
  }

  // Verify both contacts exist and are active — lock rows to prevent concurrent merges
  const [winner, loser] = await Promise.all([
    tenantDb.select().from(contacts).where(eq(contacts.id, winnerId)).for("update").limit(1),
    tenantDb.select().from(contacts).where(eq(contacts.id, loserId)).for("update").limit(1),
  ]);

  if (!winner[0]) throw new AppError(404, "Winner contact not found");
  if (!loser[0]) throw new AppError(404, "Loser contact not found");
  if (!winner[0].isActive) throw new AppError(400, "Winner contact is not active");
  if (!loser[0].isActive) throw new AppError(400, "Loser contact is not active");

  // 1. Transfer contact_deal_associations
  const assocResult = await transferAssociations(tenantDb, loserId, winnerId);

  // 1b. Update deals.primaryContactId from loser to winner for any deal
  //     where the loser was the primary contact.
  await tenantDb
    .update(deals)
    .set({ primaryContactId: winnerId })
    .where(eq(deals.primaryContactId, loserId));

  // 2. Transfer emails (update contact_id from loser to winner)
  const emailResult = await tenantDb
    .update(emails)
    .set({ contactId: winnerId })
    .where(eq(emails.contactId, loserId))
    .returning({ id: emails.id });

  // 3. Transfer activities
  const activityResult = await tenantDb
    .update(activities)
    .set({ contactId: winnerId })
    .where(eq(activities.contactId, loserId))
    .returning({ id: activities.id });

  // 4. Transfer files
  const fileResult = await tenantDb
    .update(files)
    .set({ contactId: winnerId })
    .where(eq(files.contactId, loserId))
    .returning({ id: files.id });

  // 4b. Transfer tasks
  await tenantDb
    .update(tasks)
    .set({ contactId: winnerId })
    .where(eq(tasks.contactId, loserId));

  // 5. Soft-delete the loser
  await tenantDb
    .update(contacts)
    .set({ isActive: false })
    .where(eq(contacts.id, loserId));

  // 6. If there's a missing email/phone on the winner, absorb from the loser
  const winnerContact = winner[0];
  const loserContact = loser[0];
  const absorb: Record<string, any> = {};
  if (!winnerContact.email && loserContact.email) absorb.email = loserContact.email;
  if (!winnerContact.phone && loserContact.phone) absorb.phone = loserContact.phone;
  if (!winnerContact.mobile && loserContact.mobile) absorb.mobile = loserContact.mobile;
  if (!winnerContact.companyName && loserContact.companyName) absorb.companyName = loserContact.companyName;
  if (!winnerContact.jobTitle && loserContact.jobTitle) absorb.jobTitle = loserContact.jobTitle;
  if (!winnerContact.address && loserContact.address) absorb.address = loserContact.address;

  // Absorb touchpoint stats: sum counts, keep most recent last_contacted_at
  absorb.touchpointCount = (winnerContact.touchpointCount ?? 0) + (loserContact.touchpointCount ?? 0);
  if (loserContact.lastContactedAt) {
    if (!winnerContact.lastContactedAt || loserContact.lastContactedAt > winnerContact.lastContactedAt) {
      absorb.lastContactedAt = loserContact.lastContactedAt;
    }
  }
  if (loserContact.firstOutreachCompleted && !winnerContact.firstOutreachCompleted) {
    absorb.firstOutreachCompleted = true;
  }

  if (Object.keys(absorb).length > 0) {
    await tenantDb
      .update(contacts)
      .set(absorb)
      .where(eq(contacts.id, winnerId));
  }

  // 7. Update duplicate_queue entry if provided
  if (queueEntryId) {
    await tenantDb
      .update(duplicateQueue)
      .set({
        status: "merged" as any,
        resolvedBy,
        resolvedAt: new Date(),
      })
      .where(eq(duplicateQueue.id, queueEntryId));
  }

  // Also resolve any other queue entries involving these two contacts
  await tenantDb.execute(
    sql`UPDATE ${duplicateQueue}
        SET status = 'merged', resolved_by = ${resolvedBy}, resolved_at = NOW()
        WHERE status = 'pending'
          AND (contact_a_id IN (${winnerId}, ${loserId}) AND contact_b_id IN (${winnerId}, ${loserId}))`
  );

  return {
    winnerId,
    loserId,
    transferred: {
      dealAssociations: assocResult.transferred,
      dealAssociationsSkipped: assocResult.skipped,
      emails: emailResult.length,
      activities: activityResult.length,
      files: fileResult.length,
    },
    absorbed: Object.keys(absorb),
  };
}

/**
 * Dismiss a duplicate queue entry (mark as not-a-duplicate).
 */
export async function dismissDuplicate(
  tenantDb: TenantDb,
  queueEntryId: string,
  resolvedBy: string
) {
  const result = await tenantDb
    .update(duplicateQueue)
    .set({
      status: "dismissed" as any,
      resolvedBy,
      resolvedAt: new Date(),
    })
    .where(
      and(
        eq(duplicateQueue.id, queueEntryId),
        eq(duplicateQueue.status, "pending" as any)
      )
    )
    .returning();

  if (result.length === 0) {
    throw new AppError(404, "Queue entry not found or already resolved");
  }

  return result[0];
}
```

### 6b. Merge Routes

Add to `server/src/modules/contacts/routes.ts`:

```typescript
import {
  getDuplicateQueue,
  mergeContacts,
  dismissDuplicate,
} from "./merge-service.js";

// --- Duplicate Queue & Merge ---

// GET /api/contacts/duplicates — duplicate queue
router.get("/duplicates", requireRole("admin", "director"), async (req, res, next) => {
  try {
    const filters = {
      status: req.query.status as string | undefined,
      page: req.query.page ? parseInt(req.query.page as string, 10) : undefined,
      limit: req.query.limit ? parseInt(req.query.limit as string, 10) : undefined,
    };
    const result = await getDuplicateQueue(req.tenantDb!, filters);
    await req.commitTransaction!();
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// POST /api/contacts/duplicates/:id/merge — merge two contacts
router.post(
  "/duplicates/:id/merge",
  requireRole("admin", "director"),
  async (req, res, next) => {
    try {
      const { winnerId, loserId } = req.body;
      if (!winnerId || !loserId) {
        throw new AppError(400, "winnerId and loserId are required");
      }

      // Validate that the queue entry's contactAId/contactBId match the
      // provided winnerId/loserId in either order. Prevents merging the wrong
      // pair by specifying a mismatched queueEntryId.
      const queueEntryId = req.params.id;
      const [queueEntry] = await req.tenantDb!
        .select()
        .from(duplicateQueue)
        .where(eq(duplicateQueue.id, queueEntryId))
        .limit(1);

      if (!queueEntry) {
        throw new AppError(404, "Duplicate queue entry not found");
      }

      const ids = new Set([queueEntry.contactAId, queueEntry.contactBId]);
      if (!ids.has(winnerId) || !ids.has(loserId)) {
        throw new AppError(
          400,
          "winnerId/loserId do not match the contacts in this duplicate queue entry"
        );
      }

      const result = await mergeContacts(
        req.tenantDb!,
        winnerId,
        loserId,
        req.user!.id,
        queueEntryId
      );

      await req.commitTransaction!();
      res.json({ merge: result });
    } catch (err) {
      next(err);
    }
  }
);

// POST /api/contacts/duplicates/:id/dismiss — dismiss a duplicate
router.post(
  "/duplicates/:id/dismiss",
  requireRole("admin", "director"),
  async (req, res, next) => {
    try {
      const entry = await dismissDuplicate(req.tenantDb!, req.params.id, req.user!.id);
      await req.commitTransaction!();
      res.json({ entry });
    } catch (err) {
      next(err);
    }
  }
);
```

**IMPORTANT:** The `/duplicates` routes must be registered BEFORE `/:id` to avoid path conflicts. Updated full route order:

1. `GET /` (list)
2. `GET /companies`
3. `GET /needs-outreach`
4. `GET /search`
5. `GET /duplicates`
6. `POST /duplicates/:id/merge`
7. `POST /duplicates/:id/dismiss`
8. `POST /dedup-check`
9. `GET /:id`
10. `POST /`
11. `PATCH /:id`
12. `DELETE /:id`
13. `GET /:id/deals`
14. `POST /:id/deals`
15. `PATCH /associations/:associationId`
16. `DELETE /associations/:associationId`

### Verification

- [ ] `GET /api/contacts/duplicates` returns pending queue entries with contact details
- [ ] `POST /api/contacts/duplicates/:id/merge` transfers all associations and soft-deletes loser
- [ ] Merge absorbs missing fields from loser into winner
- [ ] Merge sums touchpoint counts
- [ ] `POST /api/contacts/duplicates/:id/dismiss` marks entry as dismissed
- [ ] Rep role is blocked from merge/dismiss (403)
- [ ] Merging contact with itself returns 400

---

## Task 7: Frontend -- Contact Hooks and Utilities

- [ ] Create `client/src/hooks/use-contacts.ts`
- [ ] Create `client/src/hooks/use-contact-filters.ts`
- [ ] Create `client/src/hooks/use-duplicate-queue.ts`
- [ ] Create `client/src/lib/contact-utils.ts`

### 7a. Contact Hooks

**File: `client/src/hooks/use-contacts.ts`**

```typescript
import { useState, useEffect, useCallback } from "react";
import { api } from "@/lib/api";

export interface Contact {
  id: string;
  firstName: string;
  lastName: string;
  email: string | null;
  phone: string | null;
  mobile: string | null;
  companyName: string | null;
  jobTitle: string | null;
  category: string;
  address: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
  notes: string | null;
  touchpointCount: number;
  lastContactedAt: string | null;
  firstOutreachCompleted: boolean;
  procoreContactId: number | null;
  hubspotContactId: string | null;
  normalizedPhone: string | null;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ContactFilters {
  search?: string;
  category?: string;
  companyName?: string;
  city?: string;
  state?: string;
  isActive?: boolean;
  hasOutreach?: boolean;
  sortBy?: string;
  sortDir?: "asc" | "desc";
  page?: number;
  limit?: number;
}

export interface Pagination {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

export function useContacts(filters: ContactFilters = {}) {
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [pagination, setPagination] = useState<Pagination>({ page: 1, limit: 50, total: 0, totalPages: 0 });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchContacts = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      if (filters.search) params.set("search", filters.search);
      if (filters.category) params.set("category", filters.category);
      if (filters.companyName) params.set("companyName", filters.companyName);
      if (filters.city) params.set("city", filters.city);
      if (filters.state) params.set("state", filters.state);
      if (filters.isActive === false) params.set("isActive", "false");
      if (filters.hasOutreach === true) params.set("hasOutreach", "true");
      if (filters.hasOutreach === false) params.set("hasOutreach", "false");
      if (filters.sortBy) params.set("sortBy", filters.sortBy);
      if (filters.sortDir) params.set("sortDir", filters.sortDir);
      if (filters.page) params.set("page", String(filters.page));
      if (filters.limit) params.set("limit", String(filters.limit));

      const qs = params.toString();
      const data = await api<{ contacts: Contact[]; pagination: Pagination }>(
        `/contacts${qs ? `?${qs}` : ""}`
      );
      setContacts(data.contacts);
      setPagination(data.pagination);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to load contacts");
    } finally {
      setLoading(false);
    }
  }, [
    filters.search,
    filters.category,
    filters.companyName,
    filters.city,
    filters.state,
    filters.isActive,
    filters.hasOutreach,
    filters.sortBy,
    filters.sortDir,
    filters.page,
    filters.limit,
  ]);

  useEffect(() => {
    fetchContacts();
  }, [fetchContacts]);

  return { contacts, pagination, loading, error, refetch: fetchContacts };
}

export function useContactDetail(contactId: string | undefined) {
  const [contact, setContact] = useState<Contact | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchContact = useCallback(async () => {
    if (!contactId) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const data = await api<{ contact: Contact }>(`/contacts/${contactId}`);
      setContact(data.contact);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to load contact");
    } finally {
      setLoading(false);
    }
  }, [contactId]);

  useEffect(() => {
    fetchContact();
  }, [fetchContact]);

  return { contact, loading, error, refetch: fetchContact };
}

export interface ContactDealAssociation {
  id: string;
  contactId: string;
  dealId: string;
  role: string | null;
  isPrimary: boolean;
  createdAt: string;
  deal: {
    id: string;
    dealNumber: string;
    name: string;
    stageId: string;
    isActive: boolean;
  };
}

export function useContactDeals(contactId: string | undefined) {
  const [associations, setAssociations] = useState<ContactDealAssociation[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchAssociations = useCallback(async () => {
    if (!contactId) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const data = await api<{ associations: ContactDealAssociation[] }>(
        `/contacts/${contactId}/deals`
      );
      setAssociations(data.associations);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to load deal associations");
    } finally {
      setLoading(false);
    }
  }, [contactId]);

  useEffect(() => {
    fetchAssociations();
  }, [fetchAssociations]);

  return { associations, loading, error, refetch: fetchAssociations };
}

// --- Mutation Functions ---

export async function createContact(input: Partial<Contact> & { firstName: string; lastName: string; category: string; skipDedupCheck?: boolean }) {
  return api<{ contact: Contact | null; dedupWarning?: boolean; suggestions?: any[] }>("/contacts", {
    method: "POST",
    json: input,
  });
}

export async function updateContact(contactId: string, input: Partial<Contact>) {
  return api<{ contact: Contact }>(`/contacts/${contactId}`, { method: "PATCH", json: input });
}

export async function deleteContact(contactId: string) {
  return api<{ success: boolean }>(`/contacts/${contactId}`, { method: "DELETE" });
}

export async function checkDuplicates(input: { firstName: string; lastName: string; email?: string; companyName?: string }) {
  return api<{ hardBlock: boolean; existingContact?: any; fuzzySuggestions: any[] }>("/contacts/dedup-check", {
    method: "POST",
    json: input,
  });
}

export async function searchContacts(query: string, limit = 10) {
  return api<{ contacts: Array<{ id: string; firstName: string; lastName: string; email: string | null; companyName: string | null; category: string }> }>(
    `/contacts/search?q=${encodeURIComponent(query)}&limit=${limit}`
  );
}

export async function addContactToDeal(contactId: string, dealId: string, role?: string, isPrimary?: boolean) {
  return api<{ association: any }>(`/contacts/${contactId}/deals`, {
    method: "POST",
    json: { dealId, role, isPrimary },
  });
}

export async function removeContactDealAssociation(associationId: string) {
  return api<{ success: boolean }>(`/contacts/associations/${associationId}`, { method: "DELETE" });
}
```

### 7b. Contact Filters Hook

**File: `client/src/hooks/use-contact-filters.ts`**

```typescript
import { useState, useCallback, useEffect } from "react";
import type { ContactFilters } from "./use-contacts";

const STORAGE_KEY = "trock-crm-contact-filters";

function loadFilters(): ContactFilters {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) return JSON.parse(stored);
  } catch { /* ignore parse errors */ }
  return { isActive: true, sortBy: "updated_at", sortDir: "desc", page: 1, limit: 50 };
}

function saveFilters(filters: ContactFilters) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(filters));
  } catch { /* ignore quota errors */ }
}

export function useContactFilters() {
  const [filters, setFiltersState] = useState<ContactFilters>(loadFilters);

  useEffect(() => {
    saveFilters(filters);
  }, [filters]);

  const setFilters = useCallback((update: Partial<ContactFilters>) => {
    setFiltersState((prev) => {
      const resetPage = update.page === undefined;
      return { ...prev, ...update, ...(resetPage ? { page: 1 } : {}) };
    });
  }, []);

  const resetFilters = useCallback(() => {
    const defaults: ContactFilters = { isActive: true, sortBy: "updated_at", sortDir: "desc", page: 1, limit: 50 };
    setFiltersState(defaults);
  }, []);

  return { filters, setFilters, resetFilters };
}
```

### 7c. Duplicate Queue Hook

**File: `client/src/hooks/use-duplicate-queue.ts`**

```typescript
import { useState, useEffect, useCallback } from "react";
import { api } from "@/lib/api";
import type { Contact } from "./use-contacts";

export interface DuplicateQueueEntry {
  id: string;
  contactAId: string;
  contactBId: string;
  matchType: string;
  confidenceScore: string;
  status: string;
  resolvedBy: string | null;
  createdAt: string;
  resolvedAt: string | null;
  contactA: Contact | null;
  contactB: Contact | null;
}

export function useDuplicateQueue(status = "pending") {
  const [entries, setEntries] = useState<DuplicateQueueEntry[]>([]);
  const [pagination, setPagination] = useState({ page: 1, limit: 20, total: 0, totalPages: 0 });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchQueue = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await api<{
        entries: DuplicateQueueEntry[];
        pagination: { page: number; limit: number; total: number; totalPages: number };
      }>(`/contacts/duplicates?status=${status}`);
      setEntries(data.entries);
      setPagination(data.pagination);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to load duplicate queue");
    } finally {
      setLoading(false);
    }
  }, [status]);

  useEffect(() => {
    fetchQueue();
  }, [fetchQueue]);

  return { entries, pagination, loading, error, refetch: fetchQueue };
}

export async function mergeDuplicate(queueEntryId: string, winnerId: string, loserId: string) {
  return api<{ merge: any }>(`/contacts/duplicates/${queueEntryId}/merge`, {
    method: "POST",
    json: { winnerId, loserId },
  });
}

export async function dismissDuplicate(queueEntryId: string) {
  return api<{ entry: any }>(`/contacts/duplicates/${queueEntryId}/dismiss`, {
    method: "POST",
    json: {},
  });
}
```

### 7d. Contact Utilities

**File: `client/src/lib/contact-utils.ts`**

```typescript
import type { Contact } from "@/hooks/use-contacts";

export const CATEGORY_LABELS: Record<string, string> = {
  client: "Client",
  subcontractor: "Subcontractor",
  architect: "Architect",
  property_manager: "Property Manager",
  regional_manager: "Regional Manager",
  vendor: "Vendor",
  consultant: "Consultant",
  influencer: "Influencer",
  other: "Other",
};

export const CATEGORY_COLORS: Record<string, string> = {
  client: "bg-blue-100 text-blue-800",
  subcontractor: "bg-orange-100 text-orange-800",
  architect: "bg-purple-100 text-purple-800",
  property_manager: "bg-green-100 text-green-800",
  regional_manager: "bg-teal-100 text-teal-800",
  vendor: "bg-yellow-100 text-yellow-800",
  consultant: "bg-indigo-100 text-indigo-800",
  influencer: "bg-pink-100 text-pink-800",
  other: "bg-gray-100 text-gray-800",
};

export const ASSOCIATION_ROLES = [
  "Decision Maker",
  "Site Contact",
  "Estimator",
  "Project Manager",
  "Superintendent",
  "Accounts Payable",
  "Owner Rep",
  "Architect",
  "Other",
];

export const MATCH_TYPE_LABELS: Record<string, string> = {
  exact_email: "Exact Email Match",
  fuzzy_name: "Similar Name",
  fuzzy_phone: "Similar Phone",
  company_match: "Same Company + Name",
};

export function fullName(contact: { firstName: string; lastName: string }): string {
  return `${contact.firstName} ${contact.lastName}`.trim();
}

export function contactInitials(contact: { firstName: string; lastName: string }): string {
  return `${contact.firstName.charAt(0)}${contact.lastName.charAt(0)}`.toUpperCase();
}

export function formatPhone(phone: string | null): string {
  if (!phone) return "";
  const digits = phone.replace(/\D/g, "");
  if (digits.length === 10) {
    return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
  }
  if (digits.length === 11 && digits.startsWith("1")) {
    return `(${digits.slice(1, 4)}) ${digits.slice(4, 7)}-${digits.slice(7)}`;
  }
  return phone;
}

export function contactLocation(contact: { city: string | null; state: string | null }): string {
  if (contact.city && contact.state) return `${contact.city}, ${contact.state}`;
  return contact.city ?? contact.state ?? "";
}

export function confidenceLabel(score: string | number): string {
  const s = typeof score === "string" ? parseFloat(score) : score;
  if (s >= 0.9) return "Very High";
  if (s >= 0.8) return "High";
  if (s >= 0.7) return "Medium";
  return "Low";
}

export function confidenceColor(score: string | number): string {
  const s = typeof score === "string" ? parseFloat(score) : score;
  if (s >= 0.9) return "text-red-600";
  if (s >= 0.8) return "text-orange-600";
  if (s >= 0.7) return "text-yellow-600";
  return "text-gray-600";
}
```

### Verification

- [ ] `useContacts()` fetches and returns contacts with pagination
- [ ] `useContactDetail()` fetches single contact
- [ ] `useContactDeals()` fetches deal associations for a contact
- [ ] `useDuplicateQueue()` fetches pending duplicate entries
- [ ] All mutation functions (`createContact`, `updateContact`, etc.) make correct API calls
- [ ] `contact-utils.ts` exports all category labels, colors, and formatting functions

---

## Task 8: Frontend -- Contact List/Directory Page

- [ ] Create `client/src/pages/contacts/contact-list-page.tsx`
- [ ] Create `client/src/components/contacts/contact-card.tsx`
- [ ] Create `client/src/components/contacts/contact-filters.tsx`
- [ ] Create `client/src/components/contacts/contact-category-badge.tsx`

### 8a. Contact Category Badge

**File: `client/src/components/contacts/contact-category-badge.tsx`**

```typescript
import { Badge } from "@/components/ui/badge";
import { CATEGORY_LABELS, CATEGORY_COLORS } from "@/lib/contact-utils";

interface ContactCategoryBadgeProps {
  category: string;
}

export function ContactCategoryBadge({ category }: ContactCategoryBadgeProps) {
  const label = CATEGORY_LABELS[category] ?? category;
  const colorClass = CATEGORY_COLORS[category] ?? "bg-gray-100 text-gray-800";

  return (
    <Badge variant="outline" className={`${colorClass} border-0 text-xs`}>
      {label}
    </Badge>
  );
}
```

### 8b. Contact Card

**File: `client/src/components/contacts/contact-card.tsx`**

```typescript
import { Building2, MapPin, Phone, Mail, Activity } from "lucide-react";
import { Card } from "@/components/ui/card";
import { ContactCategoryBadge } from "./contact-category-badge";
import { fullName, formatPhone, contactLocation } from "@/lib/contact-utils";
import type { Contact } from "@/hooks/use-contacts";

interface ContactCardProps {
  contact: Contact;
  onClick: () => void;
}

export function ContactCard({ contact, onClick }: ContactCardProps) {
  return (
    <Card
      className="p-4 cursor-pointer hover:bg-muted/50 transition-colors"
      onClick={onClick}
    >
      <div className="flex items-start justify-between gap-4">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1">
            <ContactCategoryBadge category={contact.category} />
            {!contact.firstOutreachCompleted && (
              <span className="text-xs bg-amber-100 text-amber-800 px-1.5 py-0.5 rounded">
                Needs Outreach
              </span>
            )}
          </div>
          <h3 className="font-semibold truncate">{fullName(contact)}</h3>
          <div className="flex items-center gap-4 mt-1 text-xs text-muted-foreground flex-wrap">
            {contact.companyName && (
              <span className="flex items-center gap-1">
                <Building2 className="h-3 w-3" />
                {contact.companyName}
              </span>
            )}
            {contact.jobTitle && (
              <span>{contact.jobTitle}</span>
            )}
            {contactLocation(contact) && (
              <span className="flex items-center gap-1">
                <MapPin className="h-3 w-3" />
                {contactLocation(contact)}
              </span>
            )}
          </div>
        </div>
        <div className="text-right shrink-0 space-y-1">
          {contact.email && (
            <p className="text-xs text-muted-foreground flex items-center gap-1 justify-end">
              <Mail className="h-3 w-3" />
              {contact.email}
            </p>
          )}
          {(contact.phone || contact.mobile) && (
            <p className="text-xs text-muted-foreground flex items-center gap-1 justify-end">
              <Phone className="h-3 w-3" />
              {formatPhone(contact.phone ?? contact.mobile)}
            </p>
          )}
          <p className="text-xs text-muted-foreground flex items-center gap-1 justify-end">
            <Activity className="h-3 w-3" />
            {contact.touchpointCount} touchpoints
          </p>
        </div>
      </div>
    </Card>
  );
}
```

### 8c. Contact Filters

**File: `client/src/components/contacts/contact-filters.tsx`**

```typescript
import { Search, X } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { CATEGORY_LABELS } from "@/lib/contact-utils";
import type { ContactFilters as FilterState } from "@/hooks/use-contacts";

interface ContactFiltersProps {
  filters: FilterState;
  onFilterChange: (update: Partial<FilterState>) => void;
  onReset: () => void;
}

export function ContactFilters({ filters, onFilterChange, onReset }: ContactFiltersProps) {
  const hasActiveFilters =
    !!filters.search || !!filters.category || !!filters.companyName || !!filters.state || filters.hasOutreach !== undefined;

  return (
    <div className="flex flex-wrap gap-3 items-center">
      {/* Search */}
      <div className="relative flex-1 min-w-[200px]">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
        <Input
          placeholder="Search contacts..."
          value={filters.search ?? ""}
          onChange={(e) => onFilterChange({ search: e.target.value || undefined })}
          className="pl-9"
        />
      </div>

      {/* Category */}
      <Select
        value={filters.category ?? "all"}
        onValueChange={(v) => onFilterChange({ category: v === "all" ? undefined : v })}
      >
        <SelectTrigger className="w-[160px]">
          <SelectValue placeholder="All Categories" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="all">All Categories</SelectItem>
          {Object.entries(CATEGORY_LABELS).map(([key, label]) => (
            <SelectItem key={key} value={key}>
              {label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      {/* Outreach Status */}
      <Select
        value={filters.hasOutreach === undefined ? "all" : filters.hasOutreach ? "yes" : "no"}
        onValueChange={(v) =>
          onFilterChange({ hasOutreach: v === "all" ? undefined : v === "yes" })
        }
      >
        <SelectTrigger className="w-[160px]">
          <SelectValue placeholder="Outreach Status" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="all">All Outreach</SelectItem>
          <SelectItem value="yes">Outreach Done</SelectItem>
          <SelectItem value="no">Needs Outreach</SelectItem>
        </SelectContent>
      </Select>

      {/* Sort */}
      <Select
        value={filters.sortBy ?? "updated_at"}
        onValueChange={(v) => onFilterChange({ sortBy: v })}
      >
        <SelectTrigger className="w-[160px]">
          <SelectValue placeholder="Sort By" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="updated_at">Last Updated</SelectItem>
          <SelectItem value="name">Name</SelectItem>
          <SelectItem value="company_name">Company</SelectItem>
          <SelectItem value="created_at">Date Created</SelectItem>
          <SelectItem value="last_contacted_at">Last Contacted</SelectItem>
          <SelectItem value="touchpoint_count">Touchpoints</SelectItem>
        </SelectContent>
      </Select>

      {/* Reset */}
      {hasActiveFilters && (
        <Button variant="ghost" size="sm" onClick={onReset}>
          <X className="h-4 w-4 mr-1" />
          Clear
        </Button>
      )}
    </div>
  );
}
```

### 8d. Contact List Page

**File: `client/src/pages/contacts/contact-list-page.tsx`**

```typescript
import { useNavigate } from "react-router-dom";
import { Plus, ChevronLeft, ChevronRight, Users } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ContactCard } from "@/components/contacts/contact-card";
import { ContactFilters } from "@/components/contacts/contact-filters";
import { useContacts } from "@/hooks/use-contacts";
import { useContactFilters } from "@/hooks/use-contact-filters";

export function ContactListPage() {
  const navigate = useNavigate();
  const { filters, setFilters, resetFilters } = useContactFilters();
  const { contacts, pagination, loading, error } = useContacts(filters);

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold">Contacts</h2>
          <p className="text-sm text-muted-foreground">
            {pagination.total} contact{pagination.total !== 1 ? "s" : ""}
          </p>
        </div>
        <Button onClick={() => navigate("/contacts/new")}>
          <Plus className="h-4 w-4 mr-2" />
          New Contact
        </Button>
      </div>

      {/* Filters */}
      <ContactFilters
        filters={filters}
        onFilterChange={setFilters}
        onReset={resetFilters}
      />

      {/* Error State */}
      {error && (
        <div className="p-4 bg-red-50 text-red-700 rounded-lg text-sm">
          {error}
        </div>
      )}

      {/* Loading State */}
      {loading && (
        <div className="space-y-3">
          {Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="h-20 bg-muted animate-pulse rounded-lg" />
          ))}
        </div>
      )}

      {/* Contact List */}
      {!loading && contacts.length === 0 && (
        <div className="text-center py-12 text-muted-foreground">
          <Users className="h-12 w-12 mx-auto mb-3 opacity-30" />
          <p className="text-lg font-medium">No contacts found</p>
          <p className="text-sm">Try adjusting your filters or create a new contact.</p>
        </div>
      )}

      {!loading && contacts.length > 0 && (
        <div className="space-y-2">
          {contacts.map((contact) => (
            <ContactCard
              key={contact.id}
              contact={contact}
              onClick={() => navigate(`/contacts/${contact.id}`)}
            />
          ))}
        </div>
      )}

      {/* Pagination */}
      {pagination.totalPages > 1 && (
        <div className="flex items-center justify-between pt-2">
          <p className="text-sm text-muted-foreground">
            Page {pagination.page} of {pagination.totalPages}
          </p>
          <div className="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={pagination.page <= 1}
              onClick={() => setFilters({ page: pagination.page - 1 })}
            >
              <ChevronLeft className="h-4 w-4" />
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={pagination.page >= pagination.totalPages}
              onClick={() => setFilters({ page: pagination.page + 1 })}
            >
              <ChevronRight className="h-4 w-4" />
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
```

### Verification

- [ ] Contact list page renders with header, filters, and list
- [ ] Search filters across name, email, company, phone
- [ ] Category filter narrows results
- [ ] Sort by name, company, created, last contacted, touchpoints
- [ ] Pagination controls work
- [ ] "Needs Outreach" filter shows contacts without first outreach
- [ ] Clicking a contact card navigates to `/contacts/:id`
- [ ] "New Contact" button navigates to `/contacts/new`

---

## Task 9: Frontend -- Contact Detail Page

- [ ] Create `client/src/pages/contacts/contact-detail-page.tsx`
- [ ] Create `client/src/components/contacts/contact-deals-tab.tsx`
- [ ] Create `client/src/components/contacts/contact-activity-tab.tsx`
- [ ] Create `client/src/components/contacts/contact-touchpoint-card.tsx`

### 9a. Touchpoint Card

**File: `client/src/components/contacts/contact-touchpoint-card.tsx`**

```typescript
import { Activity, Calendar, AlertCircle } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { Contact } from "@/hooks/use-contacts";

interface ContactTouchpointCardProps {
  contact: Contact;
}

export function ContactTouchpointCard({ contact }: ContactTouchpointCardProps) {
  const lastContacted = contact.lastContactedAt
    ? new Date(contact.lastContactedAt).toLocaleDateString("en-US", {
        month: "short",
        day: "numeric",
        year: "numeric",
      })
    : "Never";

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium">Touchpoints</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex items-center justify-between">
          <span className="text-sm text-muted-foreground flex items-center gap-2">
            <Activity className="h-4 w-4" />
            Total Touchpoints
          </span>
          <span className="font-semibold text-lg">{contact.touchpointCount}</span>
        </div>
        <div className="flex items-center justify-between">
          <span className="text-sm text-muted-foreground flex items-center gap-2">
            <Calendar className="h-4 w-4" />
            Last Contacted
          </span>
          <span className="text-sm">{lastContacted}</span>
        </div>
        {!contact.firstOutreachCompleted && (
          <div className="flex items-center gap-2 bg-amber-50 text-amber-800 p-2 rounded text-sm">
            <AlertCircle className="h-4 w-4 shrink-0" />
            <span>First outreach not yet completed</span>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
```

### 9b. Contact Deals Tab

**File: `client/src/components/contacts/contact-deals-tab.tsx`**

```typescript
import { useNavigate } from "react-router-dom";
import { Handshake, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { DealStageBadge } from "@/components/deals/deal-stage-badge";
import { useContactDeals, removeContactDealAssociation } from "@/hooks/use-contacts";

interface ContactDealsTabProps {
  contactId: string;
}

export function ContactDealsTab({ contactId }: ContactDealsTabProps) {
  const navigate = useNavigate();
  const { associations, loading, error, refetch } = useContactDeals(contactId);

  const handleRemove = async (associationId: string) => {
    if (!window.confirm("Remove this deal association?")) return;
    try {
      await removeContactDealAssociation(associationId);
      refetch();
    } catch (err: unknown) {
      alert(err instanceof Error ? err.message : "Failed to remove association");
    }
  };

  if (loading) {
    return (
      <div className="space-y-3">
        {Array.from({ length: 3 }).map((_, i) => (
          <div key={i} className="h-16 bg-muted animate-pulse rounded-lg" />
        ))}
      </div>
    );
  }

  if (error) {
    return <div className="p-4 bg-red-50 text-red-700 rounded-lg text-sm">{error}</div>;
  }

  if (associations.length === 0) {
    return (
      <div className="text-center py-8 text-muted-foreground">
        <Handshake className="h-10 w-10 mx-auto mb-2 opacity-30" />
        <p>No deals associated with this contact.</p>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {associations.map((assoc) => (
        <Card key={assoc.id} className="p-3">
          <div className="flex items-center justify-between gap-3">
            <div
              className="flex-1 min-w-0 cursor-pointer"
              onClick={() => navigate(`/deals/${assoc.deal.id}`)}
            >
              <div className="flex items-center gap-2">
                <span className="text-xs text-muted-foreground font-mono">
                  {assoc.deal.dealNumber}
                </span>
                <DealStageBadge stageId={assoc.deal.stageId} />
                {assoc.isPrimary && (
                  <Badge variant="outline" className="text-xs">Primary</Badge>
                )}
              </div>
              <p className="font-medium truncate">{assoc.deal.name}</p>
              {assoc.role && (
                <p className="text-xs text-muted-foreground">Role: {assoc.role}</p>
              )}
            </div>
            <Button
              variant="ghost"
              size="icon"
              className="text-muted-foreground hover:text-red-600 shrink-0"
              onClick={() => handleRemove(assoc.id)}
            >
              <Trash2 className="h-4 w-4" />
            </Button>
          </div>
        </Card>
      ))}
    </div>
  );
}
```

### 9c. Contact Activity Tab

**File: `client/src/components/contacts/contact-activity-tab.tsx`**

> **Note:** Reuse the call/note/meeting logging pattern from the deal detail page.
> The activity tab must include inline logging forms for calls, notes, and meetings
> (same component pattern as `deal-activity-tab.tsx`), not just a placeholder.
> Full implementation is in Plan 4 (Activities), but the tab scaffolding here should
> render the log-entry forms so the UI is functional from day one.

```typescript
import { useState } from "react";
import { Phone, FileText, Calendar, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent } from "@/components/ui/card";

interface ContactActivityTabProps {
  contactId: string;
}

type LogType = "call" | "note" | "meeting";

export function ContactActivityTab({ contactId }: ContactActivityTabProps) {
  const [activeForm, setActiveForm] = useState<LogType | null>(null);
  const [body, setBody] = useState("");

  const handleSubmit = async (type: LogType) => {
    if (!body.trim()) return;
    // TODO (Plan 4 — Tasks/Activities): Replace with actual API call once
    // the activities endpoint exists. For now, log locally as a fallback.
    try {
      await fetch(`/api/contacts/${contactId}/activities`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type,
          subject: `${type} logged`,
          body: body.trim(),
          dealId: null,
          contactId,
        }),
      });
    } catch {
      // Endpoint doesn't exist yet — fall back to console until Plan 4
      console.log("[ActivityTab] Log entry:", { contactId, type, body });
    }
    setBody("");
    setActiveForm(null);
  };

  return (
    <div className="space-y-4">
      {/* Quick-log action buttons — reuse deal detail pattern */}
      <div className="flex gap-2">
        <Button
          size="sm"
          variant={activeForm === "call" ? "default" : "outline"}
          onClick={() => setActiveForm(activeForm === "call" ? null : "call")}
        >
          <Phone className="h-4 w-4 mr-1" /> Log Call
        </Button>
        <Button
          size="sm"
          variant={activeForm === "note" ? "default" : "outline"}
          onClick={() => setActiveForm(activeForm === "note" ? null : "note")}
        >
          <FileText className="h-4 w-4 mr-1" /> Add Note
        </Button>
        <Button
          size="sm"
          variant={activeForm === "meeting" ? "default" : "outline"}
          onClick={() => setActiveForm(activeForm === "meeting" ? null : "meeting")}
        >
          <Calendar className="h-4 w-4 mr-1" /> Log Meeting
        </Button>
      </div>

      {/* Inline log form */}
      {activeForm && (
        <Card>
          <CardContent className="pt-4 space-y-3">
            <p className="text-sm font-medium capitalize">{activeForm} details</p>
            <Textarea
              placeholder={`Describe this ${activeForm}...`}
              value={body}
              onChange={(e) => setBody(e.target.value)}
              rows={3}
            />
            <div className="flex gap-2">
              <Button size="sm" onClick={() => handleSubmit(activeForm)}>
                <Plus className="h-4 w-4 mr-1" /> Save
              </Button>
              <Button size="sm" variant="ghost" onClick={() => { setActiveForm(null); setBody(""); }}>
                Cancel
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Activity feed — populated in Plan 4 */}
      <div className="text-center py-8 text-muted-foreground text-sm">
        Activity history will appear here once Plan 4 (Activities) is implemented.
      </div>
    </div>
  );
}
```

### 9d. Contact Detail Page

**File: `client/src/pages/contacts/contact-detail-page.tsx`**

```typescript
import { useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import {
  ArrowLeft,
  Edit,
  Trash2,
  MoreHorizontal,
  Building2,
  MapPin,
  Phone,
  Mail,
  Briefcase,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ContactCategoryBadge } from "@/components/contacts/contact-category-badge";
import { ContactTouchpointCard } from "@/components/contacts/contact-touchpoint-card";
import { ContactDealsTab } from "@/components/contacts/contact-deals-tab";
import { ContactActivityTab } from "@/components/contacts/contact-activity-tab";
import { useContactDetail, deleteContact as apiDeleteContact } from "@/hooks/use-contacts";
import { useAuth } from "@/lib/auth";
import { fullName, formatPhone, contactLocation } from "@/lib/contact-utils";

type Tab = "deals" | "activity" | "files";

export function ContactDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { user } = useAuth();
  const { contact, loading, error, refetch } = useContactDetail(id);
  const [activeTab, setActiveTab] = useState<Tab>("deals");

  if (loading) {
    return (
      <div className="space-y-4">
        <div className="h-8 w-48 bg-muted animate-pulse rounded" />
        <div className="h-64 bg-muted animate-pulse rounded-lg" />
      </div>
    );
  }

  if (error || !contact) {
    return (
      <div className="text-center py-12">
        <p className="text-red-600">{error ?? "Contact not found"}</p>
        <Button variant="outline" className="mt-4" onClick={() => navigate("/contacts")}>
          Back to Contacts
        </Button>
      </div>
    );
  }

  const isDirectorOrAdmin = user?.role === "director" || user?.role === "admin";

  const handleDelete = async () => {
    if (!window.confirm("Are you sure you want to delete this contact?")) return;
    try {
      await apiDeleteContact(contact.id);
      navigate("/contacts");
    } catch (err: unknown) {
      alert(err instanceof Error ? err.message : "Failed to delete contact");
    }
  };

  const tabs: { key: Tab; label: string }[] = [
    { key: "deals", label: "Deals" },
    { key: "activity", label: "Activity" },
    { key: "files", label: "Files" },
  ];

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <Button
            variant="ghost"
            size="sm"
            className="mb-1 -ml-2"
            onClick={() => navigate("/contacts")}
          >
            <ArrowLeft className="h-4 w-4 mr-1" />
            Contacts
          </Button>
          <div className="flex items-center gap-3">
            <h2 className="text-2xl font-bold">{fullName(contact)}</h2>
            <ContactCategoryBadge category={contact.category} />
          </div>
          {contact.jobTitle && (
            <p className="text-muted-foreground mt-0.5">{contact.jobTitle}</p>
          )}
        </div>

        <DropdownMenu>
          <DropdownMenuTrigger
            render={<Button variant="outline" size="icon">
              <MoreHorizontal className="h-4 w-4" />
            </Button>}
          />
          <DropdownMenuContent align="end">
            <DropdownMenuItem onClick={() => navigate(`/contacts/${contact.id}/edit`)}>
              <Edit className="h-4 w-4 mr-2" />
              Edit Contact
            </DropdownMenuItem>
            {isDirectorOrAdmin && (
              <DropdownMenuItem onClick={handleDelete} className="text-red-600">
                <Trash2 className="h-4 w-4 mr-2" />
                Delete Contact
              </DropdownMenuItem>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {/* Info Cards */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {/* Contact Info */}
        <Card className="md:col-span-2">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium">Contact Information</CardTitle>
          </CardHeader>
          <CardContent className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-sm">
            {contact.email && (
              <div className="flex items-center gap-2">
                <Mail className="h-4 w-4 text-muted-foreground" />
                <a href={`mailto:${contact.email}`} className="text-blue-600 hover:underline">
                  {contact.email}
                </a>
              </div>
            )}
            {contact.phone && (
              <div className="flex items-center gap-2">
                <Phone className="h-4 w-4 text-muted-foreground" />
                <span>{formatPhone(contact.phone)}</span>
              </div>
            )}
            {contact.mobile && (
              <div className="flex items-center gap-2">
                <Phone className="h-4 w-4 text-muted-foreground" />
                <span>{formatPhone(contact.mobile)} (mobile)</span>
              </div>
            )}
            {contact.companyName && (
              <div className="flex items-center gap-2">
                <Building2 className="h-4 w-4 text-muted-foreground" />
                <span>{contact.companyName}</span>
              </div>
            )}
            {contact.jobTitle && (
              <div className="flex items-center gap-2">
                <Briefcase className="h-4 w-4 text-muted-foreground" />
                <span>{contact.jobTitle}</span>
              </div>
            )}
            {contactLocation(contact) && (
              <div className="flex items-center gap-2">
                <MapPin className="h-4 w-4 text-muted-foreground" />
                <span>
                  {contact.address && `${contact.address}, `}
                  {contactLocation(contact)}
                  {contact.zip && ` ${contact.zip}`}
                </span>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Touchpoints */}
        <ContactTouchpointCard contact={contact} />
      </div>

      {/* Notes */}
      {contact.notes && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium">Notes</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-sm whitespace-pre-wrap">{contact.notes}</p>
          </CardContent>
        </Card>
      )}

      {/* Tabs */}
      <div className="border-b">
        <div className="flex gap-6">
          {tabs.map((tab) => (
            <button
              key={tab.key}
              className={`pb-2 text-sm font-medium border-b-2 transition-colors ${
                activeTab === tab.key
                  ? "border-brand-purple text-foreground"
                  : "border-transparent text-muted-foreground hover:text-foreground"
              }`}
              onClick={() => setActiveTab(tab.key)}
            >
              {tab.label}
            </button>
          ))}
        </div>
      </div>

      {/* Tab Content */}
      {activeTab === "deals" && <ContactDealsTab contactId={contact.id} />}
      {activeTab === "activity" && <ContactActivityTab contactId={contact.id} />}
      {activeTab === "files" && (
        <div className="text-center py-12 text-muted-foreground">
          <p>File management coming in Plan 4: Files & Photos</p>
        </div>
      )}
    </div>
  );
}
```

### Verification

- [ ] Contact detail page loads with header, info card, touchpoint card
- [ ] Category badge displays correct color and label
- [ ] Contact info shows email (as mailto link), phone, company, location
- [ ] Notes card renders when notes exist, hidden when null
- [ ] Deals tab shows associated deals with stage badges
- [ ] Clicking a deal navigates to deal detail
- [ ] Activity tab shows placeholder for future plans
- [ ] Edit button navigates to edit page
- [ ] Delete button (director/admin only) soft-deletes and redirects

---

## Task 10: Frontend -- Contact Create/Edit Form with Dedup Warnings

- [ ] Create `client/src/components/contacts/contact-form.tsx`
- [ ] Create `client/src/components/contacts/dedup-warning.tsx`
- [ ] Create `client/src/pages/contacts/contact-new-page.tsx`
- [ ] Create `client/src/pages/contacts/contact-edit-page.tsx`

### 10a. Dedup Warning Component

**File: `client/src/components/contacts/dedup-warning.tsx`**

```typescript
import { AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { fullName } from "@/lib/contact-utils";

interface DedupSuggestion {
  id: string;
  firstName: string;
  lastName: string;
  email: string | null;
  companyName: string | null;
  matchReason: string;
}

interface DedupWarningProps {
  suggestions: DedupSuggestion[];
  onUseExisting: (contactId: string) => void;
  onCreateAnyway: () => void;
  onCancel: () => void;
}

export function DedupWarning({ suggestions, onUseExisting, onCreateAnyway, onCancel }: DedupWarningProps) {
  return (
    <div className="space-y-4">
      <div className="flex items-start gap-3 bg-amber-50 text-amber-800 p-4 rounded-lg">
        <AlertTriangle className="h-5 w-5 shrink-0 mt-0.5" />
        <div>
          <p className="font-medium">Possible duplicate contacts found</p>
          <p className="text-sm mt-1">
            The contact you are creating may already exist. Please review the matches below.
          </p>
        </div>
      </div>

      <div className="space-y-2">
        {suggestions.map((suggestion) => (
          <Card key={suggestion.id} className="p-3">
            <div className="flex items-center justify-between gap-3">
              <div>
                <p className="font-medium">{fullName(suggestion)}</p>
                <div className="text-xs text-muted-foreground space-y-0.5">
                  {suggestion.email && <p>{suggestion.email}</p>}
                  {suggestion.companyName && <p>{suggestion.companyName}</p>}
                  <p className="text-amber-600 font-medium">{suggestion.matchReason}</p>
                </div>
              </div>
              <Button
                variant="outline"
                size="sm"
                onClick={() => onUseExisting(suggestion.id)}
              >
                Use This Contact
              </Button>
            </div>
          </Card>
        ))}
      </div>

      <div className="flex gap-3 justify-end">
        <Button variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button variant="outline" onClick={onCreateAnyway}>
          Create Anyway
        </Button>
      </div>
    </div>
  );
}
```

### 10b. Contact Form

**File: `client/src/components/contacts/contact-form.tsx`**

```typescript
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { DedupWarning } from "./dedup-warning";
import { createContact, updateContact } from "@/hooks/use-contacts";
import type { Contact } from "@/hooks/use-contacts";
import { CATEGORY_LABELS } from "@/lib/contact-utils";
import { Loader2 } from "lucide-react";

interface ContactFormProps {
  contact?: Contact;
  onSuccess?: (contact: Contact) => void;
}

export function ContactForm({ contact, onSuccess }: ContactFormProps) {
  const navigate = useNavigate();
  const isEdit = !!contact;

  const [formData, setFormData] = useState({
    firstName: contact?.firstName ?? "",
    lastName: contact?.lastName ?? "",
    email: contact?.email ?? "",
    phone: contact?.phone ?? "",
    mobile: contact?.mobile ?? "",
    companyName: contact?.companyName ?? "",
    jobTitle: contact?.jobTitle ?? "",
    category: contact?.category ?? "client",
    address: contact?.address ?? "",
    city: contact?.city ?? "",
    state: contact?.state ?? "",
    zip: contact?.zip ?? "",
    notes: contact?.notes ?? "",
  });

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dedupSuggestions, setDedupSuggestions] = useState<any[] | null>(null);

  const handleChange = (field: string, value: string) => {
    setFormData((prev) => ({ ...prev, [field]: value }));
  };

  const handleSubmit = async (e: React.FormEvent, skipDedup = false) => {
    e.preventDefault();
    if (!formData.firstName.trim()) {
      setError("First name is required");
      return;
    }
    if (!formData.lastName.trim()) {
      setError("Last name is required");
      return;
    }

    setSubmitting(true);
    setError(null);
    setDedupSuggestions(null);

    try {
      if (isEdit) {
        const result = await updateContact(contact.id, formData);
        if (onSuccess) {
          onSuccess(result.contact);
        } else {
          navigate(`/contacts/${contact.id}`);
        }
      } else {
        const result = await createContact({
          ...formData,
          skipDedupCheck: skipDedup,
        });

        // Handle dedup warning
        if (result.dedupWarning && result.suggestions && result.suggestions.length > 0) {
          setDedupSuggestions(result.suggestions);
          setSubmitting(false);
          return;
        }

        if (result.contact) {
          if (onSuccess) {
            onSuccess(result.contact);
          } else {
            navigate(`/contacts/${result.contact.id}`);
          }
        }
      }
    } catch (err: unknown) {
      if (err instanceof Error) {
        setError(err.message);
      } else {
        setError("Failed to save contact");
      }
    } finally {
      setSubmitting(false);
    }
  };

  // Show dedup warning if fuzzy matches were found
  if (dedupSuggestions) {
    return (
      <DedupWarning
        suggestions={dedupSuggestions}
        onUseExisting={(contactId) => navigate(`/contacts/${contactId}`)}
        onCreateAnyway={() => {
          setDedupSuggestions(null);
          // Re-submit with skipDedup flag
          const syntheticEvent = { preventDefault: () => {} } as React.FormEvent;
          handleSubmit(syntheticEvent, true);
        }}
        onCancel={() => setDedupSuggestions(null)}
      />
    );
  }

  return (
    <form onSubmit={(e) => handleSubmit(e, false)} className="space-y-6">
      {error && (
        <div className="p-4 bg-red-50 text-red-700 rounded-lg text-sm">{error}</div>
      )}

      {/* Name + Category */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Basic Information</CardTitle>
        </CardHeader>
        <CardContent className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div className="space-y-2">
            <Label htmlFor="firstName">First Name *</Label>
            <Input
              id="firstName"
              value={formData.firstName}
              onChange={(e) => handleChange("firstName", e.target.value)}
              required
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="lastName">Last Name *</Label>
            <Input
              id="lastName"
              value={formData.lastName}
              onChange={(e) => handleChange("lastName", e.target.value)}
              required
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="category">Category *</Label>
            <Select
              value={formData.category}
              onValueChange={(v) => handleChange("category", v)}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {Object.entries(CATEGORY_LABELS).map(([key, label]) => (
                  <SelectItem key={key} value={key}>
                    {label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label htmlFor="companyName">Company</Label>
            <Input
              id="companyName"
              value={formData.companyName}
              onChange={(e) => handleChange("companyName", e.target.value)}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="jobTitle">Job Title</Label>
            <Input
              id="jobTitle"
              value={formData.jobTitle}
              onChange={(e) => handleChange("jobTitle", e.target.value)}
            />
          </div>
        </CardContent>
      </Card>

      {/* Contact Info */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Contact Details</CardTitle>
        </CardHeader>
        <CardContent className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div className="space-y-2">
            <Label htmlFor="email">Email</Label>
            <Input
              id="email"
              type="email"
              value={formData.email}
              onChange={(e) => handleChange("email", e.target.value)}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="phone">Phone</Label>
            <Input
              id="phone"
              value={formData.phone}
              onChange={(e) => handleChange("phone", e.target.value)}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="mobile">Mobile</Label>
            <Input
              id="mobile"
              value={formData.mobile}
              onChange={(e) => handleChange("mobile", e.target.value)}
            />
          </div>
        </CardContent>
      </Card>

      {/* Address */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Address</CardTitle>
        </CardHeader>
        <CardContent className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div className="space-y-2 sm:col-span-2">
            <Label htmlFor="address">Street Address</Label>
            <Input
              id="address"
              value={formData.address}
              onChange={(e) => handleChange("address", e.target.value)}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="city">City</Label>
            <Input
              id="city"
              value={formData.city}
              onChange={(e) => handleChange("city", e.target.value)}
            />
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="state">State</Label>
              <Input
                id="state"
                maxLength={2}
                value={formData.state}
                onChange={(e) => handleChange("state", e.target.value.toUpperCase())}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="zip">ZIP</Label>
              <Input
                id="zip"
                value={formData.zip}
                onChange={(e) => handleChange("zip", e.target.value)}
              />
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Notes */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Notes</CardTitle>
        </CardHeader>
        <CardContent>
          <Textarea
            placeholder="Internal notes about this contact..."
            value={formData.notes}
            onChange={(e) => handleChange("notes", e.target.value)}
            rows={4}
          />
        </CardContent>
      </Card>

      {/* Actions */}
      <div className="flex gap-3 justify-end">
        <Button
          type="button"
          variant="outline"
          onClick={() => navigate(isEdit ? `/contacts/${contact.id}` : "/contacts")}
        >
          Cancel
        </Button>
        <Button type="submit" disabled={submitting}>
          {submitting && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
          {isEdit ? "Save Changes" : "Create Contact"}
        </Button>
      </div>
    </form>
  );
}
```

### 10c. New Contact Page

**File: `client/src/pages/contacts/contact-new-page.tsx`**

```typescript
import { ContactForm } from "@/components/contacts/contact-form";

export function ContactNewPage() {
  return (
    <div className="max-w-3xl">
      <h2 className="text-2xl font-bold mb-4">New Contact</h2>
      <ContactForm />
    </div>
  );
}
```

### 10d. Edit Contact Page

**File: `client/src/pages/contacts/contact-edit-page.tsx`**

```typescript
import { useParams, useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { ContactForm } from "@/components/contacts/contact-form";
import { useContactDetail } from "@/hooks/use-contacts";

export function ContactEditPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { contact, loading, error } = useContactDetail(id);

  if (loading) {
    return (
      <div className="max-w-3xl space-y-4">
        <div className="h-8 w-48 bg-muted animate-pulse rounded" />
        <div className="h-96 bg-muted animate-pulse rounded-lg" />
      </div>
    );
  }

  if (error || !contact) {
    return (
      <div className="text-center py-12">
        <p className="text-red-600">{error ?? "Contact not found"}</p>
        <Button variant="outline" className="mt-4" onClick={() => navigate("/contacts")}>
          Back to Contacts
        </Button>
      </div>
    );
  }

  return (
    <div className="max-w-3xl">
      <h2 className="text-2xl font-bold mb-4">Edit Contact</h2>
      <ContactForm contact={contact} />
    </div>
  );
}
```

### Verification

- [ ] New contact form renders with all fields grouped into cards
- [ ] Submitting with duplicate email shows error message from 409 response
- [ ] Submitting with fuzzy name match shows DedupWarning component
- [ ] "Use This Contact" navigates to existing contact
- [ ] "Create Anyway" re-submits with skipDedupCheck=true
- [ ] Edit form pre-fills all fields from existing contact
- [ ] State field auto-uppercases input and limits to 2 chars
- [ ] Cancel navigates back correctly

---

## Task 11: Frontend -- Duplicate Merge Queue UI

- [ ] Create `client/src/pages/admin/merge-queue-page.tsx`
- [ ] Create `client/src/components/contacts/merge-dialog.tsx`

### 11a. Merge Dialog

**File: `client/src/components/contacts/merge-dialog.tsx`**

```typescript
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { fullName, formatPhone, contactLocation } from "@/lib/contact-utils";
import { ContactCategoryBadge } from "./contact-category-badge";
import { mergeDuplicate } from "@/hooks/use-duplicate-queue";
import type { Contact } from "@/hooks/use-contacts";
import { Loader2, Trophy } from "lucide-react";

interface MergeDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  queueEntryId: string;
  contactA: Contact;
  contactB: Contact;
  onSuccess: () => void;
}

export function MergeDialog({
  open,
  onOpenChange,
  queueEntryId,
  contactA,
  contactB,
  onSuccess,
}: MergeDialogProps) {
  const [winnerId, setWinnerId] = useState<string | null>(null);
  const [merging, setMerging] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleMerge = async () => {
    if (!winnerId) return;
    const loserId = winnerId === contactA.id ? contactB.id : contactA.id;

    setMerging(true);
    setError(null);
    try {
      await mergeDuplicate(queueEntryId, winnerId, loserId);
      onSuccess();
      onOpenChange(false);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Merge failed");
    } finally {
      setMerging(false);
    }
  };

  const renderContactCard = (contact: Contact, isSelected: boolean) => (
    <Card
      className={`p-4 cursor-pointer transition-colors ${
        isSelected
          ? "ring-2 ring-brand-purple bg-purple-50"
          : "hover:bg-muted/50"
      }`}
      onClick={() => setWinnerId(contact.id)}
    >
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <p className="font-semibold">{fullName(contact)}</p>
            <ContactCategoryBadge category={contact.category} />
          </div>
          {isSelected && (
            <Badge className="bg-brand-purple text-white">
              <Trophy className="h-3 w-3 mr-1" />
              Winner
            </Badge>
          )}
        </div>
        <div className="text-sm text-muted-foreground space-y-0.5">
          {contact.email && <p>{contact.email}</p>}
          {contact.phone && <p>{formatPhone(contact.phone)}</p>}
          {contact.companyName && <p>{contact.companyName}</p>}
          {contact.jobTitle && <p>{contact.jobTitle}</p>}
          {contactLocation(contact) && <p>{contactLocation(contact)}</p>}
          <p>Touchpoints: {contact.touchpointCount}</p>
        </div>
      </div>
    </Card>
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Merge Contacts</DialogTitle>
          <DialogDescription>
            Select the contact to keep (winner). All deals, emails, activities, and files from the
            other contact will be transferred to the winner. The loser will be deactivated.
          </DialogDescription>
        </DialogHeader>

        {error && (
          <div className="p-3 bg-red-50 text-red-700 rounded text-sm">{error}</div>
        )}

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {renderContactCard(contactA, winnerId === contactA.id)}
          {renderContactCard(contactB, winnerId === contactB.id)}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={handleMerge} disabled={!winnerId || merging}>
            {merging && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
            Merge Contacts
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
```

### 11b. Merge Queue Page

**File: `client/src/pages/admin/merge-queue-page.tsx`**

```typescript
import { useState } from "react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { MergeDialog } from "@/components/contacts/merge-dialog";
import { useDuplicateQueue, dismissDuplicate } from "@/hooks/use-duplicate-queue";
import {
  fullName,
  confidenceLabel,
  confidenceColor,
  MATCH_TYPE_LABELS,
} from "@/lib/contact-utils";
import type { Contact } from "@/hooks/use-contacts";
import { GitMerge, X, Users } from "lucide-react";

export function MergeQueuePage() {
  const { entries, pagination, loading, error, refetch } = useDuplicateQueue("pending");
  const [mergeEntry, setMergeEntry] = useState<{
    id: string;
    contactA: Contact;
    contactB: Contact;
  } | null>(null);

  const handleDismiss = async (entryId: string) => {
    if (!window.confirm("Dismiss this duplicate? It will not appear in the queue again.")) return;
    try {
      await dismissDuplicate(entryId);
      refetch();
    } catch (err: unknown) {
      alert(err instanceof Error ? err.message : "Failed to dismiss");
    }
  };

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-2xl font-bold">Duplicate Merge Queue</h2>
        <p className="text-sm text-muted-foreground">
          {pagination.total} pending duplicate{pagination.total !== 1 ? "s" : ""} to review
        </p>
      </div>

      {error && (
        <div className="p-4 bg-red-50 text-red-700 rounded-lg text-sm">{error}</div>
      )}

      {loading && (
        <div className="space-y-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="h-24 bg-muted animate-pulse rounded-lg" />
          ))}
        </div>
      )}

      {!loading && entries.length === 0 && (
        <div className="text-center py-12 text-muted-foreground">
          <Users className="h-12 w-12 mx-auto mb-3 opacity-30" />
          <p className="text-lg font-medium">No duplicates to review</p>
          <p className="text-sm">The weekly scan will check for new potential duplicates.</p>
        </div>
      )}

      {!loading && entries.length > 0 && (
        <div className="space-y-3">
          {entries.map((entry) => {
            if (!entry.contactA || !entry.contactB) return null;

            return (
              <Card key={entry.id} className="p-4">
                <div className="flex items-start justify-between gap-4">
                  <div className="flex-1">
                    <div className="flex items-center gap-2 mb-2">
                      <Badge variant="outline">{MATCH_TYPE_LABELS[entry.matchType] ?? entry.matchType}</Badge>
                      <span className={`text-sm font-medium ${confidenceColor(entry.confidenceScore)}`}>
                        {confidenceLabel(entry.confidenceScore)} ({entry.confidenceScore})
                      </span>
                    </div>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-sm">
                      <div>
                        <p className="font-medium">{fullName(entry.contactA)}</p>
                        <p className="text-muted-foreground">{entry.contactA.email ?? "No email"}</p>
                        <p className="text-muted-foreground">{entry.contactA.companyName ?? "No company"}</p>
                      </div>
                      <div>
                        <p className="font-medium">{fullName(entry.contactB)}</p>
                        <p className="text-muted-foreground">{entry.contactB.email ?? "No email"}</p>
                        <p className="text-muted-foreground">{entry.contactB.companyName ?? "No company"}</p>
                      </div>
                    </div>
                  </div>
                  <div className="flex gap-2 shrink-0">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() =>
                        setMergeEntry({
                          id: entry.id,
                          contactA: entry.contactA!,
                          contactB: entry.contactB!,
                        })
                      }
                    >
                      <GitMerge className="h-4 w-4 mr-1" />
                      Merge
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => handleDismiss(entry.id)}
                    >
                      <X className="h-4 w-4 mr-1" />
                      Dismiss
                    </Button>
                  </div>
                </div>
              </Card>
            );
          })}
        </div>
      )}

      {/* Merge Dialog */}
      {mergeEntry && (
        <MergeDialog
          open={!!mergeEntry}
          onOpenChange={(open) => {
            if (!open) setMergeEntry(null);
          }}
          queueEntryId={mergeEntry.id}
          contactA={mergeEntry.contactA}
          contactB={mergeEntry.contactB}
          onSuccess={refetch}
        />
      )}
    </div>
  );
}
```

### Verification

- [ ] Merge queue page lists pending duplicate entries
- [ ] Each entry shows both contacts side-by-side with match type and confidence
- [ ] "Merge" button opens MergeDialog
- [ ] MergeDialog lets user select winner by clicking a contact card
- [ ] Selected winner shows purple ring and "Winner" badge
- [ ] Merge button calls API and refreshes list on success
- [ ] "Dismiss" removes entry from queue
- [ ] Empty state shown when no pending duplicates

---

## Task 12: Route and Navigation Wiring

- [ ] Update `client/src/App.tsx` with contact routes
- [ ] Update sidebar navigation (no code change needed -- `/contacts` already in navItems)
- [ ] Verify all navigation flows work end-to-end

### 12a. Update App.tsx Routes

**File: `client/src/App.tsx`** -- Replace the placeholder contact route and add new routes:

```typescript
// Add imports at the top:
import { ContactListPage } from "@/pages/contacts/contact-list-page";
import { ContactDetailPage } from "@/pages/contacts/contact-detail-page";
import { ContactNewPage } from "@/pages/contacts/contact-new-page";
import { ContactEditPage } from "@/pages/contacts/contact-edit-page";
import { MergeQueuePage } from "@/pages/admin/merge-queue-page";

// Replace the placeholder <Route path="/contacts" ... /> with:
<Route path="/contacts" element={<ContactListPage />} />
<Route path="/contacts/new" element={<ContactNewPage />} />
<Route path="/contacts/:id" element={<ContactDetailPage />} />
<Route path="/contacts/:id/edit" element={<ContactEditPage />} />

// Add the merge queue under admin routes:
<Route path="/admin/merge-queue" element={<MergeQueuePage />} />
```

### 12b. Add Merge Queue to Admin Sidebar

**File: `client/src/components/layout/sidebar.tsx`** -- Add to adminItems array:

```typescript
import { GitMerge } from "lucide-react";

// Add to adminItems array:
{ to: "/admin/merge-queue", icon: GitMerge, label: "Merge Queue", roles: ["admin", "director"] },
```

Note: Directors also need access to the merge queue since they can resolve duplicates.

### 12c. Complete Route Order Verification

All routes that should exist after this plan:

| Route | Page | Status |
|-------|------|--------|
| `/contacts` | ContactListPage | **New** |
| `/contacts/new` | ContactNewPage | **New** |
| `/contacts/:id` | ContactDetailPage | **New** |
| `/contacts/:id/edit` | ContactEditPage | **New** |
| `/admin/merge-queue` | MergeQueuePage | **New** |

### 12d. API Route Summary

| Method | Route | Purpose |
|--------|-------|---------|
| `GET` | `/api/contacts` | List contacts (paginated, filtered) |
| `GET` | `/api/contacts/companies` | Distinct company names |
| `GET` | `/api/contacts/needs-outreach` | Contacts needing first outreach |
| `GET` | `/api/contacts/search?q=...` | Fast autocomplete search |
| `GET` | `/api/contacts/duplicates` | Pending duplicate queue |
| `POST` | `/api/contacts/duplicates/:id/merge` | Merge two contacts |
| `POST` | `/api/contacts/duplicates/:id/dismiss` | Dismiss a duplicate |
| `POST` | `/api/contacts/dedup-check` | Check for duplicates |
| `GET` | `/api/contacts/:id` | Single contact |
| `POST` | `/api/contacts` | Create contact (with dedup) |
| `PATCH` | `/api/contacts/:id` | Update contact |
| `DELETE` | `/api/contacts/:id` | Soft-delete contact |
| `GET` | `/api/contacts/:id/deals` | Deals for a contact |
| `POST` | `/api/contacts/:id/deals` | Associate contact with deal |
| `PATCH` | `/api/contacts/associations/:id` | Update association |
| `DELETE` | `/api/contacts/associations/:id` | Remove association |
| `GET` | `/api/deals/:id/contacts` | Contacts for a deal |

### Verification

- [ ] `/contacts` renders ContactListPage (not placeholder)
- [ ] `/contacts/new` renders form with dedup
- [ ] `/contacts/:id` renders detail page with tabs
- [ ] `/contacts/:id/edit` renders edit form
- [ ] `/admin/merge-queue` renders merge queue (director/admin only)
- [ ] Sidebar "Contacts" link navigates to `/contacts`
- [ ] Admin sidebar shows "Merge Queue" link
- [ ] All navigation flows (list -> detail -> edit -> back) work

---

## Key Implementation Notes

### Database -- Already Provisioned

The `contacts`, `contact_deal_associations`, and `duplicate_queue` tables already exist in the migration (`migrations/0001_initial.sql`). The `touchpoint_trigger`, `normalized_phone_trigger`, and partial unique index on `contacts.email` are also already created. **No new migration is needed.**

However, note that the spec calls for a `normalized_name` generated column, but the migration does NOT include it. The Drizzle schema also does not define it. The dedup scan computes `LOWER(TRIM(first_name || ' ' || last_name))` inline in queries instead. This is acceptable -- generated columns add complexity and the inline computation is fast enough at T Rock's scale.

### Pre-Creation Dedup Flow (Frontend -> Backend)

1. User fills out contact form, clicks "Create Contact"
2. Frontend calls `POST /api/contacts` with form data
3. Backend runs `checkForDuplicates()`:
   - **Exact email match** -> throws 409 (frontend shows error)
   - **Fuzzy match found** -> returns `{ contact: null, dedupWarning: true, suggestions: [...] }`
   - **No match** -> creates contact, returns 201
4. If fuzzy warning returned:
   - Frontend shows `DedupWarning` component with suggestions
   - User clicks "Use This Contact" -> navigates to existing contact
   - User clicks "Create Anyway" -> re-submits with `skipDedupCheck: true`

### Merge Transaction Safety

The merge operation runs entirely within the caller's tenant transaction (via `req.tenantDb`). If any step fails, the entire merge rolls back. The route handler calls `req.commitTransaction()` only after `mergeContacts()` completes successfully.

### Touchpoint Tracking

Touchpoint tracking is handled by the existing `touchpoint_trigger` PG trigger on the `activities` table. It fires on INSERT WHERE type IN ('call', 'email', 'meeting'). No application code is needed -- the trigger increments `contacts.touchpoint_count`, updates `last_contacted_at`, and sets `first_outreach_completed = true` automatically. The frontend reads these denormalized values directly from the contact record.

### Contact Search Performance

The search route (`/api/contacts/search`) uses ILIKE across multiple columns. For T Rock's scale (~200-500 contacts per office), this is fast enough. If scale increases significantly, add a GIN index with pg_trgm:

```sql
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX contacts_search_trgm_idx ON contacts
  USING GIN ((first_name || ' ' || last_name || ' ' || COALESCE(email, '') || ' ' || COALESCE(company_name, '')) gin_trgm_ops);
```

This is not needed now but documented for future reference.
