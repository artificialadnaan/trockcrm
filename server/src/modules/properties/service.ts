import { and, asc, count, desc, eq, ilike, inArray, isNotNull, sql, type SQL } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import {
  companies,
  deals,
  leads,
  properties,
} from "@trock-crm/shared/schema";
import type * as schema from "@trock-crm/shared/schema";
import { AppError } from "../../middleware/error-handler.js";
import { dealBestEstimateWithForecastSql, effectiveDealValueSql } from "../shared/deal-value-sql.js";

type TenantDb = NodePgDatabase<typeof schema>;

export interface PropertyFilters {
  search?: string;
  companyId?: string;
  type?: string;
  isActive?: boolean;
  /** Inclusive lower/upper bounds on a property's folded Linked Value (sum of active linked deal value). */
  minLinkedValue?: number;
  maxLinkedValue?: number;
  sortBy?: string;
  sortDir?: "asc" | "desc";
  page?: number;
  limit?: number;
}

function propertyOrderExpr(col: unknown, dir: "asc" | "desc") {
  // Blanks/nulls always sink to the bottom in both directions (matches the client comparators).
  return dir === "asc" ? sql`${col} ASC NULLS LAST` : sql`${col} DESC NULLS LAST`;
}

/**
 * ORDER BY for the properties directory, applied over the FULL filtered set before LIMIT/OFFSET so the
 * sort is global, not just the visible page. Directly-orderable columns — Property name, Type, Owner
 * company, Sq ft (COALESCE(roof_area, unit_count)) — plus Linked value, which is folded into the main
 * query as the LEFT JOINed `dv.linked_value` derived column (so its ORDER BY also runs over the full set
 * before LIMIT). The remaining aggregate columns (Engagement, Last touch) are still computed in
 * post-pagination sub-queries and are intentionally NOT sortable (a deferred follow-up). No sortBy keeps
 * the directory's natural multi-key order (owner company → property name → address).
 */
export function buildPropertySortOrder(sortBy: string | undefined, sortDir: "asc" | "desc" = "asc"): SQL[] {
  switch (sortBy) {
    case "name":
      return [propertyOrderExpr(properties.name, sortDir)];
    case "type":
      // properties.type is a Postgres ENUM — bare ORDER BY sorts by ENUM DECLARATION order, not
      // alphabetically. Cast to text so the directory sorts by the value the user reads (Healthcare,
      // Industrial, Office, …) and matches the client text comparator.
      return [propertyOrderExpr(sql`${properties.type}::text`, sortDir)];
    case "company":
      return [propertyOrderExpr(companies.name, sortDir)];
    case "sqft":
      return [propertyOrderExpr(sql`COALESCE(${properties.roofArea}, ${properties.unitCount})`, sortDir)];
    case "linked_value":
      // Folded `dv.linked_value` (text) cast to numeric so the directory sorts by money value, not
      // lexically; COALESCE(...,0) so properties with no active linked deal sort as $0, not NULL.
      return [propertyOrderExpr(sql`COALESCE(dv.linked_value::numeric, 0)`, sortDir)];
    default:
      return [asc(companies.name), asc(properties.name), asc(properties.address)];
  }
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
  address?: string | null;
  city?: string | null;
  state?: string | null;
  zip?: string | null;
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

function normalizeOptionalText(value: unknown) {
  if (value === undefined) {
    return undefined;
  }
  if (value === null) {
    return null;
  }
  if (typeof value !== "string") {
    throw new AppError(400, "Property address fields must be strings or null");
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeRequiredUpdateText(value: unknown, fieldLabel: string) {
  const normalized = normalizeOptionalText(value);
  if (normalized == null) {
    throw new AppError(400, `${fieldLabel} cannot be blank when provided`);
  }
  return normalized;
}

function validateOptionalState(value: unknown) {
  const normalized = normalizeOptionalText(value);
  if (normalized == null) {
    return normalized;
  }
  const state = normalized.toUpperCase();
  if (!US_STATE_PATTERN.test(state)) {
    throw new AppError(400, "State must be a 2-letter US state code");
  }
  return state;
}

function validateRequiredUpdateState(value: unknown) {
  const state = normalizeRequiredUpdateText(value, "State").toUpperCase();
  if (!US_STATE_PATTERN.test(state)) {
    throw new AppError(400, "State must be a 2-letter US state code");
  }
  return state;
}

function validateOptionalZip(value: unknown) {
  const normalized = normalizeOptionalText(value);
  if (normalized == null) {
    return normalized;
  }
  if (!ZIP_PATTERN.test(normalized)) {
    throw new AppError(400, "ZIP must be 5 digits or ZIP+4");
  }
  return normalized;
}

function validateRequiredUpdateZip(value: unknown) {
  const zip = normalizeRequiredUpdateText(value, "ZIP");
  if (!ZIP_PATTERN.test(zip)) {
    throw new AppError(400, "ZIP must be 5 digits or ZIP+4");
  }
  return zip;
}

export function buildPropertyUpdatePatch(input: UpdatePropertyInput): Partial<typeof properties.$inferInsert> {
  const patch: Partial<typeof properties.$inferInsert> = {};

  if (Object.prototype.hasOwnProperty.call(input, "address")) {
    patch.address = normalizeRequiredUpdateText(input.address, "Address");
  }
  if (Object.prototype.hasOwnProperty.call(input, "city")) {
    patch.city = normalizeRequiredUpdateText(input.city, "City");
  }
  if (Object.prototype.hasOwnProperty.call(input, "state")) {
    patch.state = validateRequiredUpdateState(input.state);
  }
  if (Object.prototype.hasOwnProperty.call(input, "zip")) {
    patch.zip = validateRequiredUpdateZip(input.zip);
  }
  if (Object.prototype.hasOwnProperty.call(input, "buildYear")) {
    patch.buildYear = validateOptionalPropertyBuildYear(input.buildYear);
  }
  if (Object.prototype.hasOwnProperty.call(input, "unitCount")) {
    patch.unitCount = validateOptionalPropertyUnitCount(input.unitCount);
  }

  return patch;
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

export function buildPropertyLastActivityAt(input: {
  persistedLastActivityAt: string | null;
  leadActivityAt: string | null;
  dealActivityAt: string | null;
}) {
  return combineLatestTimestamp(
    input.persistedLastActivityAt,
    input.leadActivityAt,
    input.dealActivityAt
  );
}

function toNumericString(value: unknown) {
  return String(value ?? "0");
}

export type PropertyEngagementStatus = "active_deal" | "active_lead" | "won" | "no_engagement";

export function classifyPropertyEngagementStatus(input: {
  dealCount: number;
  leadCount: number;
  convertedDealCount: number;
}): PropertyEngagementStatus {
  if (input.convertedDealCount > 0) return "won";
  if (input.dealCount > 0) return "active_deal";
  if (input.leadCount > 0) return "active_lead";
  return "no_engagement";
}

export function buildPropertyEngagementStatus(input: {
  leads: Array<{ isActive: boolean }>;
  deals: Array<{ isActive: boolean; sourceLeadId?: string | null }>;
}): PropertyEngagementStatus {
  return classifyPropertyEngagementStatus(buildPropertyRelationshipCounts(input));
}

export function buildPropertyRelationshipCounts(input: {
  leads: Array<{ isActive: boolean }>;
  deals: Array<{ isActive: boolean; onHold?: boolean | null; sourceLeadId?: string | null }>;
}) {
  const activeDeals = input.deals.filter((deal) => deal.isActive);
  return {
    leadCount: input.leads.filter((lead) => lead.isActive).length,
    dealCount: activeDeals.length,
    activeDealsCount: activeDeals.filter((deal) => !deal.onHold).length,
    convertedDealCount: input.deals.filter((deal) => Boolean(deal.sourceLeadId)).length,
  };
}

export async function listProperties(
  tenantDb: TenantDb,
  filters: PropertyFilters = {}
) {
  const page = filters.page ?? 1;
  const limit = filters.limit ?? 100;
  const offset = (page - 1) * limit;

  // Linked Value is FOLDED into the main query as a 1:1 LEFT JOINed derived table (`dv`) — one
  // GROUP BY property_id pass over active deals — so the WHERE (min/max range) and ORDER BY can reference
  // it and operate over the FULL filtered set BEFORE LIMIT/OFFSET (not just the visible page). The SUM
  // expression is byte-identical to the property-detail resolver below (and to the old per-page
  // sub-query) so the folded value always equals the displayed value. A per-relation derived table (not a
  // multi-relation join) keeps the 1:1 join from fanning out the property rows.
  const linkedValues = tenantDb
    .select({
      propertyId: deals.propertyId,
      linkedValue: sql<string>`COALESCE(SUM(${effectiveDealValueSql(
        deals,
        dealBestEstimateWithForecastSql(deals)
      )}), 0)::text`.as("linked_value"),
    })
    .from(deals)
    // Only active deals that are actually attached to a property: a NULL property_id can never match the
    // 1:1 LEFT JOIN below, so excluding it here keeps those rows out of the GROUP BY scan on every request.
    .where(and(eq(deals.isActive, true), isNotNull(deals.propertyId)))
    .groupBy(deals.propertyId)
    .as("dv");

  const conditions = [eq(properties.isActive, filters.isActive ?? true)];

  if (filters.companyId) {
    conditions.push(eq(properties.companyId, filters.companyId));
  }
  if (filters.type) {
    conditions.push(eq(properties.type, filters.type as any));
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

  // Min/max Linked Value range, AND-composed with the Type filter + search above. Bounds are bind
  // params (never interpolated). `!= null` so a 0 lower bound is honoured (>= 0), and the COALESCE
  // matches the sort so properties with no active linked deal count as $0.
  const hasLinkedValueFilter = filters.minLinkedValue != null || filters.maxLinkedValue != null;
  if (filters.minLinkedValue != null) {
    conditions.push(sql`COALESCE(dv.linked_value::numeric, 0) >= ${filters.minLinkedValue}`);
  }
  if (filters.maxLinkedValue != null) {
    conditions.push(sql`COALESCE(dv.linked_value::numeric, 0) <= ${filters.maxLinkedValue}`);
  }

  const where = and(...conditions);

  const rows = await tenantDb
    .select({
      id: properties.id,
      companyId: properties.companyId,
      name: properties.name,
      address: properties.address,
      city: properties.city,
      state: properties.state,
      zip: properties.zip,
      type: properties.type,
      buildYear: properties.buildYear,
      unitCount: properties.unitCount,
      floors: properties.floors,
      roofArea: properties.roofArea,
      notes: properties.notes,
      lastActivityAt: properties.lastActivityAt,
      procoreId: properties.procoreId,
      companycamId: properties.companycamId,
      isActive: properties.isActive,
      createdAt: properties.createdAt,
      updatedAt: properties.updatedAt,
      companyName: companies.name,
      // Folded Linked Value (text); LEFT JOIN leaves it NULL for properties with no active deal → '0'.
      linkedValue: sql<string>`COALESCE(dv.linked_value, '0')`,
    })
    .from(properties)
    .leftJoin(companies, eq(companies.id, properties.companyId))
    .leftJoin(linkedValues, eq(linkedValues.propertyId, properties.id))
    .where(where)
    // Server-side sort over the full filtered set; stable id tiebreak keeps OFFSET paging deterministic.
    .orderBy(...buildPropertySortOrder(filters.sortBy, filters.sortDir), asc(properties.id))
    .limit(limit)
    .offset(offset);
  // The count must join `dv` only when the WHERE actually references it (a linked-value range filter is
  // set) so the filtered total stays correct; the 1:1 join never changes the property row count, so
  // total == COUNT(filtered properties). When unfiltered we skip the join to avoid a redundant aggregate.
  const totalBase = tenantDb.select({ count: count() }).from(properties);
  const totalResult = await (hasLinkedValueFilter
    ? totalBase.leftJoin(linkedValues, eq(linkedValues.propertyId, properties.id))
    : totalBase
  ).where(where);

  const propertyIds = rows.map((row) => row.id);
  if (propertyIds.length === 0) {
    return {
      properties: [],
      page,
      limit,
      total: Number(totalResult[0]?.count ?? 0),
    };
  }

  const leadCounts = await tenantDb
    .select({ propertyId: leads.propertyId, count: count() })
    .from(leads)
    .where(and(inArray(leads.propertyId, propertyIds), eq(leads.isActive, true)))
    .groupBy(leads.propertyId);
  const dealCounts = await tenantDb
    .select({ propertyId: deals.propertyId, count: count() })
    .from(deals)
    .where(and(inArray(deals.propertyId, propertyIds), eq(deals.isActive, true)))
    .groupBy(deals.propertyId);
  const activeDealCounts = await tenantDb
    .select({ propertyId: deals.propertyId, count: count() })
    .from(deals)
    .where(and(inArray(deals.propertyId, propertyIds), eq(deals.isActive, true), sql`COALESCE(${deals.onHold}, false) = false`))
    .groupBy(deals.propertyId);
  const convertedCounts = await tenantDb
    .select({ propertyId: deals.propertyId, count: count() })
    .from(deals)
    .where(and(inArray(deals.propertyId, propertyIds), sql`${deals.sourceLeadId} is not null`))
    .groupBy(deals.propertyId);
  const leadActivity = await tenantDb
    .select({
      propertyId: leads.propertyId,
      lastActivityAt: sql<Date | null>`max(${leads.lastActivityAt})`,
    })
    .from(leads)
    .where(inArray(leads.propertyId, propertyIds))
    .groupBy(leads.propertyId);
  const dealActivity = await tenantDb
    .select({
      propertyId: deals.propertyId,
      lastActivityAt: sql<Date | null>`max(${deals.lastActivityAt})`,
    })
    .from(deals)
    .where(inArray(deals.propertyId, propertyIds))
    .groupBy(deals.propertyId);
  // Linked Value is no longer fetched here — it is FOLDED into the main row query (`dv` LEFT JOIN above)
  // via the byte-identical resolver SUM, so it can drive the WHERE range filter + ORDER BY over the full
  // set. Each row already carries `linkedValue`.
  const photoCounts = await tenantDb.execute(sql`
      SELECT linked.property_id, COUNT(DISTINCT linked.file_id)::int AS photos_count
      FROM (
        SELECT d.property_id, f.id AS file_id
        FROM files f
        INNER JOIN deals d ON d.id = f.deal_id
        WHERE d.property_id IN (${sql.join(propertyIds.map(id => sql`${id}`), sql`, `)})
          AND f.category = 'photo'
          AND f.is_active = true
        UNION
        SELECT l.property_id, f.id AS file_id
        FROM files f
        INNER JOIN leads l ON l.id = f.lead_id
        WHERE l.property_id IN (${sql.join(propertyIds.map(id => sql`${id}`), sql`, `)})
          AND f.category = 'photo'
          AND f.is_active = true
      ) linked
      GROUP BY linked.property_id
    `);

  const leadCountMap = new Map(leadCounts.map((row) => [row.propertyId, coerceCount(row.count)]));
  const dealCountMap = new Map(dealCounts.map((row) => [row.propertyId, coerceCount(row.count)]));
  const activeDealCountMap = new Map(activeDealCounts.map((row) => [row.propertyId, coerceCount(row.count)]));
  const convertedCountMap = new Map(convertedCounts.map((row) => [row.propertyId, coerceCount(row.count)]));
  const leadActivityMap = new Map(leadActivity.map((row) => [row.propertyId, coerceTimestamp(row.lastActivityAt)]));
  const dealActivityMap = new Map(dealActivity.map((row) => [row.propertyId, coerceTimestamp(row.lastActivityAt)]));
  const photoCountRows = (photoCounts as any).rows ?? photoCounts;
  const photosCountMap = new Map(photoCountRows.map((row: any) => [row.property_id, Number(row.photos_count ?? 0)]));

  return {
    properties: rows.map((row) => ({
      ...row,
      leadCount: leadCountMap.get(row.id) ?? 0,
      dealCount: dealCountMap.get(row.id) ?? 0,
      activeDealsCount: activeDealCountMap.get(row.id) ?? 0,
      convertedDealCount: convertedCountMap.get(row.id) ?? 0,
      lastActivityAt: buildPropertyLastActivityAt({
        persistedLastActivityAt: coerceTimestamp(row.lastActivityAt),
        leadActivityAt: leadActivityMap.get(row.id) ?? null,
        dealActivityAt: dealActivityMap.get(row.id) ?? null,
      }),
      engagementStatus: classifyPropertyEngagementStatus({
        dealCount: activeDealCountMap.get(row.id) ?? 0,
        leadCount: leadCountMap.get(row.id) ?? 0,
        convertedDealCount: convertedCountMap.get(row.id) ?? 0,
      }),
      // Folded in the main query (`dv` LEFT JOIN); COALESCE already floors NULL → '0', normalize defensively.
      linkedValue: toNumericString(row.linkedValue),
      activePipelineValue: toNumericString(row.linkedValue),
      photosCount: photosCountMap.get(row.id) ?? 0,
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
  const patch = buildPropertyUpdatePatch(input);

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
      type: properties.type,
      propertyType: properties.propertyType,
      buildYear: properties.buildYear,
      unitCount: properties.unitCount,
      lat: properties.lat,
      lng: properties.lng,
      floors: properties.floors,
      roofArea: properties.roofArea,
      notes: properties.notes,
      lastActivityAt: properties.lastActivityAt,
      procoreId: properties.procoreId,
      procorePropertyId: properties.procorePropertyId,
      companycamId: properties.companycamId,
      companycamProjectId: properties.companycamProjectId,
      hubspotPropertyId: properties.hubspotPropertyId,
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

  const relatedLeads = await tenantDb
    .select()
    .from(leads)
    .where(eq(leads.propertyId, propertyId))
    .orderBy(desc(leads.updatedAt), desc(leads.createdAt));
  const relatedDeals = await tenantDb
    .select()
    .from(deals)
    .where(eq(deals.propertyId, propertyId))
    .orderBy(desc(deals.updatedAt), desc(deals.createdAt));
  const linkedValueRows = await tenantDb
    .select({
      linkedValue: sql<string>`COALESCE(SUM(${effectiveDealValueSql(
        deals,
        dealBestEstimateWithForecastSql(deals)
      )}), 0)::text`,
    })
    .from(deals)
    .where(and(eq(deals.propertyId, propertyId), eq(deals.isActive, true)));
  const photoCounts = await tenantDb.execute(sql`
      SELECT COUNT(DISTINCT linked.file_id)::int AS photos_count
      FROM (
        SELECT f.id AS file_id
        FROM files f
        INNER JOIN deals d ON d.id = f.deal_id
        WHERE d.property_id = ${propertyId}
          AND f.category = 'photo'
          AND f.is_active = true
        UNION
        SELECT f.id AS file_id
        FROM files f
        INNER JOIN leads l ON l.id = f.lead_id
        WHERE l.property_id = ${propertyId}
          AND f.category = 'photo'
          AND f.is_active = true
      ) linked
    `);
  const photoCountRows = (photoCounts as any).rows ?? photoCounts;
  const relationshipCounts = buildPropertyRelationshipCounts({
    leads: relatedLeads,
    deals: relatedDeals,
  });
  const linkedValue = linkedValueRows[0]?.linkedValue ?? "0";

  return {
    property: {
      ...property,
      ...relationshipCounts,
      lastActivityAt: buildPropertyLastActivityAt({
        persistedLastActivityAt: coerceTimestamp(property.lastActivityAt),
        leadActivityAt: combineLatestTimestamp(...relatedLeads.map((lead) => coerceTimestamp(lead.lastActivityAt))),
        dealActivityAt: combineLatestTimestamp(...relatedDeals.map((deal) => coerceTimestamp(deal.lastActivityAt))),
      }),
      engagementStatus: classifyPropertyEngagementStatus(relationshipCounts),
      linkedValue,
      activePipelineValue: linkedValue,
      photosCount: Number(photoCountRows[0]?.photos_count ?? 0),
    },
    leads: relatedLeads,
    deals: relatedDeals,
  };
}
