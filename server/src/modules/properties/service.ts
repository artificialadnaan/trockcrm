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
  buildYear?: number | null;
  unitCount?: number | null;
  notes?: string | null;
}

export interface UpdatePropertyInput {
  buildYear?: number | string | null;
  unitCount?: number | string | null;
}

const US_STATE_PATTERN = /^[A-Z]{2}$/;
const ZIP_PATTERN = /^\d{5}(-\d{4})?$/;

export function validatePropertyAddressFields(input: {
  address?: string | null;
  city?: string | null;
  state?: string | null;
  zip?: string | null;
}) {
  const missing: string[] = [];
  if (!input.address?.trim()) missing.push("address");
  if (!input.city?.trim()) missing.push("city");
  if (!input.state?.trim()) missing.push("state");
  if (!input.zip?.trim()) missing.push("zip");

  if (missing.length > 0) {
    throw new AppError(400, `Property address is incomplete: ${missing.join(", ")}`);
  }

  const normalizedState = input.state!.trim().toUpperCase();
  if (!US_STATE_PATTERN.test(normalizedState)) {
    throw new AppError(400, "State must be a 2-letter US state code");
  }

  const normalizedZip = input.zip!.trim();
  if (!ZIP_PATTERN.test(normalizedZip)) {
    throw new AppError(400, "ZIP must be 5 digits or ZIP+4");
  }

  return {
    address: input.address!.trim(),
    city: input.city!.trim(),
    state: normalizedState,
    zip: normalizedZip,
  };
}

export function validatePropertyBuildYear(value: unknown, now = new Date()) {
  const year = typeof value === "string" ? Number(value) : value;
  const maxYear = now.getFullYear() + 2;
  if (!Number.isInteger(year) || (year as number) < 1800 || (year as number) > maxYear) {
    throw new AppError(400, `Year built must be between 1800 and ${maxYear}`);
  }
  return year as number;
}

export function validatePropertyUnitCount(value: unknown) {
  const count = typeof value === "string" ? Number(value) : value;
  if (!Number.isInteger(count) || (count as number) <= 0) {
    throw new AppError(400, "Number of units must be a positive integer");
  }
  return count as number;
}

function validateOptionalPropertyBuildYear(value: unknown) {
  if (value === undefined || value === null || value === "") {
    return null;
  }
  return validatePropertyBuildYear(value);
}

function validateOptionalPropertyUnitCount(value: unknown) {
  if (value === undefined || value === null || value === "") {
    return null;
  }
  return validatePropertyUnitCount(value);
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
        buildYear: properties.buildYear,
        unitCount: properties.unitCount,
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
  const address = validatePropertyAddressFields(input);
  const buildYear = validateOptionalPropertyBuildYear(input.buildYear);
  const unitCount = validateOptionalPropertyUnitCount(input.unitCount);

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
      address: address.address,
      city: address.city,
      state: address.state,
      zip: address.zip,
      buildYear,
      unitCount,
      notes: input.notes ?? null,
      isActive: true,
    })
    .returning();

  return property;
}

export async function updateProperty(tenantDb: TenantDb, propertyId: string, input: UpdatePropertyInput) {
  const patch: Partial<typeof properties.$inferInsert> = {};

  if (Object.prototype.hasOwnProperty.call(input, "buildYear")) {
    patch.buildYear = validateOptionalPropertyBuildYear(input.buildYear);
  }
  if (Object.prototype.hasOwnProperty.call(input, "unitCount")) {
    patch.unitCount = validateOptionalPropertyUnitCount(input.unitCount);
  }

  if (Object.keys(patch).length === 0) {
    const [existing] = await tenantDb.select().from(properties).where(eq(properties.id, propertyId)).limit(1);
    return existing ?? null;
  }

  const [property] = await tenantDb
    .update(properties)
    .set({
      ...patch,
      updatedAt: new Date(),
    })
    .where(eq(properties.id, propertyId))
    .returning();

  return property ?? null;
}

export async function deleteProperty(tenantDb: TenantDb, propertyId: string) {
  const [existing] = await tenantDb
    .select()
    .from(properties)
    .where(eq(properties.id, propertyId))
    .limit(1);

  if (!existing) {
    throw new AppError(404, "Property not found");
  }

  if (!existing.isActive) {
    return null;
  }

  const [property] = await tenantDb
    .update(properties)
    .set({
      isActive: false,
      updatedAt: new Date(),
    })
    .where(eq(properties.id, propertyId))
    .returning();

  return property ?? null;
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
      buildYear: properties.buildYear,
      unitCount: properties.unitCount,
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
