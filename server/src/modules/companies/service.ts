import { eq, and, ilike, asc, desc, count, sql } from "drizzle-orm";
import { companies, contacts, deals } from "@trock-crm/shared/schema";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";

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
      .select({
        id: companies.id,
        name: companies.name,
        slug: companies.slug,
        category: companies.category,
        address: companies.address,
        city: companies.city,
        state: companies.state,
        zip: companies.zip,
        phone: companies.phone,
        website: companies.website,
        notes: companies.notes,
        isActive: companies.isActive,
        createdAt: companies.createdAt,
        updatedAt: companies.updatedAt,
        contactCount: sql<number>`(SELECT COUNT(*)::int FROM contacts WHERE contacts.company_id = ${companies.id} AND contacts.is_active = true)`,
        dealCount: sql<number>`(SELECT COUNT(*)::int FROM deals WHERE deals.company_id = ${companies.id} AND deals.is_active = true)`,
      })
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
  if (data.name) updates.slug = await uniqueSlug(tenantDb, slugify(data.name), id);
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
