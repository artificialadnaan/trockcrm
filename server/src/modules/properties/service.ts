import { and, asc, count, desc, eq, ilike, inArray, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import {
  companies,
  deals,
  leads,
  properties,
} from "@trock-crm/shared/schema";
import type * as schema from "@trock-crm/shared/schema";
import { AppError } from "../../middleware/error-handler.js";

type TenantDb = NodePgDatabase<typeof schema>;

export interface PropertyFilters {
  search?: string;
  companyId?: string;
  isActive?: boolean;
  page?: number;
  limit?: number;
}

export interface CreatePropertyInput {
  companyId: string;
  name: string;
  address?: string | null;
  city?: string | null;
  state?: string | null;
  zip?: string | null;
  notes?: string | null;
}

function coerceCount(value: unknown) {
  return Number(value ?? 0);
}

function coerceTimestamp(value: unknown) {
  return value instanceof Date ? value.toISOString() : (value as string | null) ?? null;
}

function combineLatestTimestamp(...values: Array<string | null>) {
  return values
    .filter((value): value is string => Boolean(value))
    .sort((left, right) => new Date(right).getTime() - new Date(left).getTime())[0] ?? null;
}

export async function listProperties(
  tenantDb: TenantDb,
  filters: PropertyFilters = {}
) {
  const page = filters.page ?? 1;
  const limit = filters.limit ?? 100;
  const offset = (page - 1) * limit;

  const conditions = [eq(properties.isActive, filters.isActive ?? true)];

  if (filters.companyId) {
    conditions.push(eq(properties.companyId, filters.companyId));
  }

  if (filters.search?.trim()) {
    const searchTerm = `%${filters.search.trim()}%`;
    conditions.push(
      sql`(
        ${properties.name} ILIKE ${searchTerm}
        OR ${properties.address} ILIKE ${searchTerm}
        OR ${properties.city} ILIKE ${searchTerm}
        OR ${properties.state} ILIKE ${searchTerm}
        OR ${properties.zip} ILIKE ${searchTerm}
      )`
    );
  }

  const where = and(...conditions);

  const [rows, totalResult] = await Promise.all([
    tenantDb
      .select({
        id: properties.id,
        companyId: properties.companyId,
        name: properties.name,
        address: properties.address,
        city: properties.city,
        state: properties.state,
        zip: properties.zip,
        notes: properties.notes,
        isActive: properties.isActive,
        createdAt: properties.createdAt,
        updatedAt: properties.updatedAt,
        companyName: companies.name,
      })
      .from(properties)
      .leftJoin(companies, eq(companies.id, properties.companyId))
      .where(where)
      .orderBy(asc(companies.name), asc(properties.name), asc(properties.address))
      .limit(limit)
      .offset(offset),
    tenantDb.select({ count: count() }).from(properties).where(where),
  ]);

  const propertyIds = rows.map((row) => row.id);
  if (propertyIds.length === 0) {
    return {
      properties: [],
      page,
      limit,
      total: Number(totalResult[0]?.count ?? 0),
    };
  }

  const [leadCounts, dealCounts, convertedCounts, leadActivity, dealActivity] = await Promise.all([
    tenantDb
      .select({ propertyId: leads.propertyId, count: count() })
      .from(leads)
      .where(inArray(leads.propertyId, propertyIds))
      .groupBy(leads.propertyId),
    tenantDb
      .select({ propertyId: deals.propertyId, count: count() })
      .from(deals)
      .where(inArray(deals.propertyId, propertyIds))
      .groupBy(deals.propertyId),
    tenantDb
      .select({ propertyId: deals.propertyId, count: count() })
      .from(deals)
      .where(and(inArray(deals.propertyId, propertyIds), sql`${deals.sourceLeadId} is not null`))
      .groupBy(deals.propertyId),
    tenantDb
      .select({
        propertyId: leads.propertyId,
        lastActivityAt: sql<Date | null>`max(${leads.lastActivityAt})`,
      })
      .from(leads)
      .where(inArray(leads.propertyId, propertyIds))
      .groupBy(leads.propertyId),
    tenantDb
      .select({
        propertyId: deals.propertyId,
        lastActivityAt: sql<Date | null>`max(${deals.lastActivityAt})`,
      })
      .from(deals)
      .where(inArray(deals.propertyId, propertyIds))
      .groupBy(deals.propertyId),
  ]);

  const leadCountMap = new Map(leadCounts.map((row) => [row.propertyId, coerceCount(row.count)]));
  const dealCountMap = new Map(dealCounts.map((row) => [row.propertyId, coerceCount(row.count)]));
  const convertedCountMap = new Map(convertedCounts.map((row) => [row.propertyId, coerceCount(row.count)]));
  const leadActivityMap = new Map(leadActivity.map((row) => [row.propertyId, coerceTimestamp(row.lastActivityAt)]));
  const dealActivityMap = new Map(dealActivity.map((row) => [row.propertyId, coerceTimestamp(row.lastActivityAt)]));

  return {
    properties: rows.map((row) => ({
      ...row,
      leadCount: leadCountMap.get(row.id) ?? 0,
      dealCount: dealCountMap.get(row.id) ?? 0,
      convertedDealCount: convertedCountMap.get(row.id) ?? 0,
      lastActivityAt: combineLatestTimestamp(
        leadActivityMap.get(row.id) ?? null,
        dealActivityMap.get(row.id) ?? null
      ),
    })),
    page,
    limit,
    total: Number(totalResult[0]?.count ?? 0),
  };
}

export async function createProperty(tenantDb: TenantDb, input: CreatePropertyInput) {
  const [company] = await tenantDb
    .select({ id: companies.id })
    .from(companies)
    .where(and(eq(companies.id, input.companyId), eq(companies.isActive, true)))
    .limit(1);

  if (!company) {
    throw new AppError(400, "Company not found");
  }

  const [property] = await tenantDb
    .insert(properties)
    .values({
      companyId: input.companyId,
      name: input.name,
      address: input.address ?? null,
      city: input.city ?? null,
      state: input.state ?? null,
      zip: input.zip ?? null,
      notes: input.notes ?? null,
      isActive: true,
    })
    .returning();

  return property;
}

export async function getPropertyDetail(tenantDb: TenantDb, propertyId: string) {
  const [property] = await tenantDb
    .select({
      id: properties.id,
      companyId: properties.companyId,
      name: properties.name,
      address: properties.address,
      city: properties.city,
      state: properties.state,
      zip: properties.zip,
      notes: properties.notes,
      isActive: properties.isActive,
      createdAt: properties.createdAt,
      updatedAt: properties.updatedAt,
      companyName: companies.name,
    })
    .from(properties)
    .leftJoin(companies, eq(companies.id, properties.companyId))
    .where(eq(properties.id, propertyId))
    .limit(1);

  if (!property) {
    return null;
  }

  const [relatedLeads, relatedDeals] = await Promise.all([
    tenantDb
      .select()
      .from(leads)
      .where(eq(leads.propertyId, propertyId))
      .orderBy(desc(leads.updatedAt), desc(leads.createdAt)),
    tenantDb
      .select()
      .from(deals)
      .where(eq(deals.propertyId, propertyId))
      .orderBy(desc(deals.updatedAt), desc(deals.createdAt)),
  ]);

  return {
    property: {
      ...property,
      leadCount: relatedLeads.length,
      dealCount: relatedDeals.length,
      convertedDealCount: relatedDeals.filter((deal) => Boolean(deal.sourceLeadId)).length,
      lastActivityAt: combineLatestTimestamp(
        ...relatedLeads.map((lead) => coerceTimestamp(lead.lastActivityAt)),
        ...relatedDeals.map((deal) => coerceTimestamp(deal.lastActivityAt))
      ),
    },
    leads: relatedLeads,
    deals: relatedDeals,
  };
}
