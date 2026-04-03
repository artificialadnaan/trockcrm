# Companies Module Implementation Plan

> **For agentic workers:** Use superpowers:subagent-driven-development to implement this plan task-by-task.

**Goal:** Add a Companies entity so contacts and deals are organized under companies, with a company directory page and inline company creation from the contact form.

**Architecture:** New `companies` table in tenant schema. FK `company_id` added to `contacts` (NOT NULL) and `deals` (nullable). Backend CRUD module following existing patterns. Frontend directory page + detail page + company selector component. Backfill script creates companies from existing `company_name` data.

**Tech Stack:** Drizzle ORM, Express, React, Tailwind, shadcn/ui

---

### Task 1: Database Schema — Drizzle + SQL Migration

**Files:**
- Create: `shared/src/schema/tenant/companies.ts`
- Modify: `shared/src/schema/tenant/contacts.ts` — add companyId column
- Modify: `shared/src/schema/tenant/deals.ts` — add companyId column
- Modify: `shared/src/schema/index.ts` — export companies
- Create: `migrations/0005_companies.sql`

- [ ] **Step 1: Create Drizzle schema for companies**

```typescript
// shared/src/schema/tenant/companies.ts
import {
  pgTable,
  uuid,
  varchar,
  text,
  boolean,
  timestamp,
  index,
} from "drizzle-orm/pg-core";
import { contactCategoryEnum } from "./contacts.js";

export const companies = pgTable(
  "companies",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: varchar("name", { length: 500 }).notNull(),
    slug: varchar("slug", { length: 100 }).unique().notNull(),
    category: contactCategoryEnum("category").notNull(),
    address: text("address"),
    city: varchar("city", { length: 255 }),
    state: varchar("state", { length: 2 }),
    zip: varchar("zip", { length: 10 }),
    phone: varchar("phone", { length: 20 }),
    website: varchar("website", { length: 500 }),
    notes: text("notes"),
    isActive: boolean("is_active").default(true).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("companies_name_idx").on(table.name),
    index("companies_category_idx").on(table.category),
  ]
);
```

- [ ] **Step 2: Add companyId to contacts and deals Drizzle schemas**

In `contacts.ts`, add after `companyName`:
```typescript
companyId: uuid("company_id"),
```

In `deals.ts`, add after `primaryContactId`:
```typescript
companyId: uuid("company_id"),
```

- [ ] **Step 3: Export companies from schema index**

Add to `shared/src/schema/index.ts`:
```typescript
export { companies } from "./tenant/companies.js";
```

- [ ] **Step 4: Write SQL migration 0005_companies.sql**

```sql
-- Migration 0005: Companies table and FK columns
-- Runs per-tenant schema (the migration runner applies to all office schemas)

CREATE TABLE IF NOT EXISTS companies (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(500) NOT NULL,
  slug VARCHAR(100) UNIQUE NOT NULL,
  category contact_category NOT NULL DEFAULT 'other',
  address TEXT,
  city VARCHAR(255),
  state VARCHAR(2),
  zip VARCHAR(10),
  phone VARCHAR(20),
  website VARCHAR(500),
  notes TEXT,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS companies_name_idx ON companies(name);
CREATE INDEX IF NOT EXISTS companies_category_idx ON companies(category);

-- Add company_id to contacts (nullable initially for backfill)
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS company_id UUID REFERENCES companies(id);
CREATE INDEX IF NOT EXISTS contacts_company_id_idx ON contacts(company_id);

-- Add company_id to deals (nullable)
ALTER TABLE deals ADD COLUMN IF NOT EXISTS company_id UUID REFERENCES companies(id);
CREATE INDEX IF NOT EXISTS deals_company_id_idx ON deals(company_id);

-- Updated-at trigger for companies
DO $$ BEGIN
  CREATE TRIGGER set_companies_updated_at
    BEFORE UPDATE ON companies FOR EACH ROW EXECUTE FUNCTION set_updated_at();
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
```

- [ ] **Step 5: Build shared workspace, verify**

```bash
npm run build --workspace=shared
```

- [ ] **Step 6: Commit**

```bash
git add shared/src/schema/tenant/companies.ts shared/src/schema/tenant/contacts.ts shared/src/schema/tenant/deals.ts shared/src/schema/index.ts migrations/0005_companies.sql
git commit -m "feat: add companies table schema and migration"
```

---

### Task 2: Backend — Companies Service

**Files:**
- Create: `server/src/modules/companies/service.ts`

- [ ] **Step 1: Write the companies service**

```typescript
// server/src/modules/companies/service.ts
import { eq, and, ilike, sql, desc, asc, count } from "drizzle-orm";
import { companies, contacts, deals } from "@trock-crm/shared/schema";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";

type TenantDb = NodePgDatabase<any>;

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .substring(0, 100);
}

export async function listCompanies(
  tenantDb: TenantDb,
  options: { search?: string; category?: string; page?: number; limit?: number } = {}
) {
  const page = options.page ?? 1;
  const limit = options.limit ?? 50;
  const offset = (page - 1) * limit;

  const conditions = [eq(companies.isActive, true)];
  if (options.search) {
    conditions.push(ilike(companies.name, `%${options.search}%`));
  }
  if (options.category) {
    conditions.push(eq(companies.category, options.category as any));
  }

  const where = and(...conditions);

  const [rows, totalResult] = await Promise.all([
    tenantDb
      .select()
      .from(companies)
      .where(where)
      .orderBy(asc(companies.name))
      .limit(limit)
      .offset(offset),
    tenantDb
      .select({ count: count() })
      .from(companies)
      .where(where),
  ]);

  return { companies: rows, total: totalResult[0]?.count ?? 0, page, limit };
}

export async function getCompanyById(tenantDb: TenantDb, id: string) {
  const rows = await tenantDb
    .select()
    .from(companies)
    .where(eq(companies.id, id))
    .limit(1);
  return rows[0] ?? null;
}

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
  }
) {
  const slug = slugify(data.name);
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
    })
    .returning();
  return rows[0];
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
  const updates: any = { ...data };
  if (data.name) updates.slug = slugify(data.name);
  if (data.category) updates.category = data.category as any;

  const rows = await tenantDb
    .update(companies)
    .set(updates)
    .where(eq(companies.id, id))
    .returning();
  return rows[0] ?? null;
}

export async function getCompanyContacts(tenantDb: TenantDb, companyId: string) {
  return tenantDb
    .select()
    .from(contacts)
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
  const [contactCount, dealCount] = await Promise.all([
    tenantDb.select({ count: count() }).from(contacts).where(and(eq(contacts.companyId, companyId), eq(contacts.isActive, true))),
    tenantDb.select({ count: count() }).from(deals).where(and(eq(deals.companyId, companyId), eq(deals.isActive, true))),
  ]);
  return {
    contactCount: contactCount[0]?.count ?? 0,
    dealCount: dealCount[0]?.count ?? 0,
  };
}

export async function searchCompanies(tenantDb: TenantDb, query: string, limit = 10) {
  return tenantDb
    .select({ id: companies.id, name: companies.name, category: companies.category })
    .from(companies)
    .where(and(ilike(companies.name, `%${query}%`), eq(companies.isActive, true)))
    .orderBy(asc(companies.name))
    .limit(limit);
}
```

- [ ] **Step 2: Commit**

```bash
git add server/src/modules/companies/service.ts
git commit -m "feat: add companies service with CRUD and stats"
```

---

### Task 3: Backend — Companies Routes

**Files:**
- Create: `server/src/modules/companies/routes.ts`
- Modify: `server/src/app.ts` — mount company routes

- [ ] **Step 1: Write the companies routes**

```typescript
// server/src/modules/companies/routes.ts
import { Router } from "express";
import {
  listCompanies,
  getCompanyById,
  createCompany,
  updateCompany,
  getCompanyContacts,
  getCompanyDeals,
  getCompanyStats,
  searchCompanies,
} from "./service.js";
import { AppError } from "../../middleware/error-handler.js";

const router = Router();

// GET /companies/search?q=greystar — autocomplete for dropdowns
router.get("/search", async (req, res, next) => {
  try {
    const q = (req.query.q as string) || "";
    const results = await searchCompanies(req.tenantDb!, q);
    await req.commitTransaction!();
    res.json({ companies: results });
  } catch (err) { next(err); }
});

// GET /companies — list with search, filter, pagination
router.get("/", async (req, res, next) => {
  try {
    const { search, category, page, limit } = req.query as Record<string, string>;
    const result = await listCompanies(req.tenantDb!, {
      search,
      category,
      page: page ? parseInt(page, 10) : 1,
      limit: limit ? parseInt(limit, 10) : 50,
    });
    await req.commitTransaction!();
    res.json(result);
  } catch (err) { next(err); }
});

// GET /companies/:id
router.get("/:id", async (req, res, next) => {
  try {
    const company = await getCompanyById(req.tenantDb!, req.params.id);
    if (!company) throw new AppError(404, "Company not found");
    const stats = await getCompanyStats(req.tenantDb!, req.params.id);
    await req.commitTransaction!();
    res.json({ ...company, ...stats });
  } catch (err) { next(err); }
});

// POST /companies
router.post("/", async (req, res, next) => {
  try {
    const { name, category, address, city, state, zip, phone, website, notes } = req.body;
    if (!name) throw new AppError(400, "Company name is required");
    const company = await createCompany(req.tenantDb!, {
      name, category: category || "other", address, city, state, zip, phone, website, notes,
    });
    await req.commitTransaction!();
    res.status(201).json(company);
  } catch (err) { next(err); }
});

// PATCH /companies/:id
router.patch("/:id", async (req, res, next) => {
  try {
    const company = await updateCompany(req.tenantDb!, req.params.id, req.body);
    if (!company) throw new AppError(404, "Company not found");
    await req.commitTransaction!();
    res.json(company);
  } catch (err) { next(err); }
});

// GET /companies/:id/contacts
router.get("/:id/contacts", async (req, res, next) => {
  try {
    const list = await getCompanyContacts(req.tenantDb!, req.params.id);
    await req.commitTransaction!();
    res.json({ contacts: list });
  } catch (err) { next(err); }
});

// GET /companies/:id/deals
router.get("/:id/deals", async (req, res, next) => {
  try {
    const list = await getCompanyDeals(req.tenantDb!, req.params.id);
    await req.commitTransaction!();
    res.json({ deals: list });
  } catch (err) { next(err); }
});

export const companyRoutes = router;
```

- [ ] **Step 2: Mount in app.ts**

Add to tenant router section in `server/src/app.ts`:
```typescript
import { companyRoutes } from "./modules/companies/routes.js";
// ...
tenantRouter.use("/companies", companyRoutes);
```

- [ ] **Step 3: Build and verify**

```bash
npm run build --workspace=server
```

- [ ] **Step 4: Commit**

```bash
git add server/src/modules/companies/ server/src/app.ts
git commit -m "feat: add companies API routes"
```

---

### Task 4: Backfill Script + Run Migration

**Files:**
- Create: `scripts/backfill-companies.ts`

- [ ] **Step 1: Write the backfill script**

```typescript
// scripts/backfill-companies.ts
import pg from "pg";
import dotenv from "dotenv";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

dotenv.config({ path: join(dirname(fileURLToPath(import.meta.url)), "../.env") });

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) { console.error("DATABASE_URL required"); process.exit(1); }

const OFFICE_SLUG = process.env.OFFICE_SLUG || "dallas";

function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").substring(0, 100);
}

async function main() {
  const client = new pg.Client({ connectionString: DATABASE_URL });
  await client.connect();

  try {
    const schema = `office_${OFFICE_SLUG}`;
    await client.query(`SET search_path = '${schema}', 'public'`);

    // 1. Get distinct company names
    const { rows: companyNames } = await client.query(
      `SELECT DISTINCT company_name FROM contacts WHERE company_name IS NOT NULL AND company_name != '' ORDER BY company_name`
    );
    console.log(`Found ${companyNames.length} unique companies`);

    // 2. Insert companies
    let created = 0;
    const slugCounts = new Map<string, number>();
    for (const { company_name } of companyNames) {
      let slug = slugify(company_name);
      // Handle duplicate slugs
      const count = slugCounts.get(slug) || 0;
      if (count > 0) slug = `${slug}-${count}`;
      slugCounts.set(slug, count + 1);

      await client.query(
        `INSERT INTO companies (name, slug, category) VALUES ($1, $2, 'other') ON CONFLICT (slug) DO NOTHING`,
        [company_name, slug]
      );
      created++;
    }
    console.log(`Created ${created} companies`);

    // 3. Create "Independent / Unknown" company for contacts without a company
    await client.query(
      `INSERT INTO companies (name, slug, category) VALUES ('Independent / Unknown', 'independent-unknown', 'other') ON CONFLICT (slug) DO NOTHING`
    );

    // 4. Backfill contact.company_id from company_name
    const { rowCount: linked } = await client.query(`
      UPDATE contacts c
      SET company_id = co.id
      FROM companies co
      WHERE c.company_name = co.name AND c.company_id IS NULL
    `);
    console.log(`Linked ${linked} contacts to companies by name`);

    // 5. Assign remaining contacts to "Independent / Unknown"
    const { rowCount: orphans } = await client.query(`
      UPDATE contacts
      SET company_id = (SELECT id FROM companies WHERE slug = 'independent-unknown')
      WHERE company_id IS NULL
    `);
    console.log(`Assigned ${orphans} contacts to Independent / Unknown`);

    // 6. Backfill deal.company_id from primary contact's company
    const { rowCount: dealLinks } = await client.query(`
      UPDATE deals d
      SET company_id = c.company_id
      FROM contacts c
      WHERE d.primary_contact_id = c.id AND d.company_id IS NULL AND c.company_id IS NOT NULL
    `);
    console.log(`Linked ${dealLinks} deals to companies via primary contact`);

    // Verify
    const { rows: [{ c: nullContacts }] } = await client.query(`SELECT COUNT(*) as c FROM contacts WHERE company_id IS NULL`);
    console.log(`\nContacts without company: ${nullContacts}`);
    console.log("Backfill complete.");
  } catch (err) {
    console.error("Backfill failed:", err);
    process.exit(1);
  } finally {
    await client.end();
  }
}

main();
```

- [ ] **Step 2: Commit**

```bash
git add scripts/backfill-companies.ts
git commit -m "feat: add companies backfill script"
```

---

### Task 5: Frontend — Company Directory + Detail Pages

**Files:**
- Create: `client/src/pages/companies/company-list-page.tsx`
- Create: `client/src/pages/companies/company-detail-page.tsx`
- Create: `client/src/pages/companies/company-new-page.tsx`
- Modify: `client/src/App.tsx` — add routes
- Modify: `client/src/components/layout/app-shell.tsx` — add sidebar nav item

Frontend pages follow existing patterns (contact-list-page, contact-detail-page).

- [ ] **Step 1: Company list page**
- [ ] **Step 2: Company detail page with Contacts/Deals tabs**
- [ ] **Step 3: Company create page**
- [ ] **Step 4: Add routes to App.tsx**
- [ ] **Step 5: Add "Companies" to sidebar navigation**
- [ ] **Step 6: Build and verify**

```bash
npm run build --workspace=client
```

- [ ] **Step 7: Commit**

```bash
git add client/src/pages/companies/ client/src/App.tsx client/src/components/layout/app-shell.tsx
git commit -m "feat: add company directory and detail pages"
```

---

### Task 6: Frontend — Company Selector on Contact Form

**Files:**
- Create: `client/src/components/companies/company-selector.tsx`
- Modify: contact form component — add company selector with "Add New" inline option

- [ ] **Step 1: Create company selector dropdown with search + add new**
- [ ] **Step 2: Integrate into contact form as required field**
- [ ] **Step 3: Build and verify**
- [ ] **Step 4: Commit**

---

### Task 7: Run Migration + Backfill on Railway

- [ ] **Step 1: Run migration 0005 against Railway database**
- [ ] **Step 2: Run backfill script**
- [ ] **Step 3: Deploy updated code**
- [ ] **Step 4: Verify in the UI**

---

### Task 8: Codex Review

- [ ] **Step 1: Run Codex review on all new/modified files**
- [ ] **Step 2: Fix any issues found**
- [ ] **Step 3: Re-run until clean**
- [ ] **Step 4: Final commit and deploy**
