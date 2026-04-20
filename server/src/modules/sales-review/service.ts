import { and, desc, eq, gte, inArray } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import {
  activities,
  companies,
  deals,
  leads,
  properties,
  users,
} from "@trock-crm/shared/schema";
import type * as schema from "@trock-crm/shared/schema";
import type {
  SalesReviewActivityCadenceRow,
  SalesReviewFilters,
  SalesReviewForecastRow,
  SalesReviewOverview,
} from "@trock-crm/shared/types";
import { evaluateSalesHygieneRecords } from "./hygiene-service.js";

type TenantDb = NodePgDatabase<typeof schema>;

type SalesReviewActor = {
  role: "admin" | "director" | "rep";
  userId: string;
};

function subtractDays(base: Date, days: number) {
  const next = new Date(base);
  next.setUTCDate(next.getUTCDate() - days);
  return next;
}

function toNumber(value: unknown): number | null {
  if (value == null || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeDateRange(filters: SalesReviewFilters) {
  const now = new Date();
  const to = filters.to ? new Date(filters.to) : now;
  const from = filters.from ? new Date(filters.from) : subtractDays(to, 14);
  return { from, to };
}

function activityBucket(type: string) {
  switch (type) {
    case "call":
    case "voicemail":
      return "calls";
    case "email":
      return "emails";
    case "meeting":
      return "meetings";
    case "lunch":
      return "lunches";
    case "site_visit":
      return "siteVisits";
    case "proposal_sent":
      return "proposalsSent";
    case "follow_up":
      return "followUps";
    default:
      return null;
  }
}

function makeCadenceRow(repId: string, repName: string): SalesReviewActivityCadenceRow {
  return {
    repId,
    repName,
    calls7d: 0,
    calls14d: 0,
    calls30d: 0,
    emails7d: 0,
    emails14d: 0,
    emails30d: 0,
    meetings7d: 0,
    meetings14d: 0,
    meetings30d: 0,
    lunches7d: 0,
    lunches14d: 0,
    lunches30d: 0,
    siteVisits7d: 0,
    siteVisits14d: 0,
    siteVisits30d: 0,
    proposalsSent7d: 0,
    proposalsSent14d: 0,
    proposalsSent30d: 0,
    followUps7d: 0,
    followUps14d: 0,
    followUps30d: 0,
  };
}

function incrementCadenceRow(
  row: SalesReviewActivityCadenceRow,
  bucket: NonNullable<ReturnType<typeof activityBucket>>,
  ageDays: number
) {
  if (bucket === "calls") {
    if (ageDays <= 30) row.calls30d += 1;
    if (ageDays <= 14) row.calls14d += 1;
    if (ageDays <= 7) row.calls7d += 1;
    return;
  }
  if (bucket === "emails") {
    if (ageDays <= 30) row.emails30d += 1;
    if (ageDays <= 14) row.emails14d += 1;
    if (ageDays <= 7) row.emails7d += 1;
    return;
  }
  if (bucket === "meetings") {
    if (ageDays <= 30) row.meetings30d += 1;
    if (ageDays <= 14) row.meetings14d += 1;
    if (ageDays <= 7) row.meetings7d += 1;
    return;
  }
  if (bucket === "lunches") {
    if (ageDays <= 30) row.lunches30d += 1;
    if (ageDays <= 14) row.lunches14d += 1;
    if (ageDays <= 7) row.lunches7d += 1;
    return;
  }
  if (bucket === "siteVisits") {
    if (ageDays <= 30) row.siteVisits30d += 1;
    if (ageDays <= 14) row.siteVisits14d += 1;
    if (ageDays <= 7) row.siteVisits7d += 1;
    return;
  }
  if (bucket === "proposalsSent") {
    if (ageDays <= 30) row.proposalsSent30d += 1;
    if (ageDays <= 14) row.proposalsSent14d += 1;
    if (ageDays <= 7) row.proposalsSent7d += 1;
    return;
  }
  if (ageDays <= 30) row.followUps30d += 1;
  if (ageDays <= 14) row.followUps14d += 1;
  if (ageDays <= 7) row.followUps7d += 1;
}

export function buildSalesReviewOverview(input: {
  actor: SalesReviewActor;
  filters: SalesReviewFilters;
  leads: Array<typeof leads.$inferSelect>;
  deals: Array<typeof deals.$inferSelect>;
  activities: Array<typeof activities.$inferSelect>;
  users: Array<{ id: string; displayName: string | null }>;
  companies: Array<{ id: string; name: string | null }>;
  properties: Array<{ id: string; name: string | null }>;
}): SalesReviewOverview {
  const { actor, filters } = input;
  const { from, to } = normalizeDateRange(filters);
  const now = new Date();
  const repFilter = actor.role === "rep" ? actor.userId : filters.repId;
  const userNameMap = new Map(input.users.map((user) => [user.id, user.displayName ?? "Unknown User"]));
  const companyMap = new Map(input.companies.map((company) => [company.id, company.name ?? null]));
  const propertyMap = new Map(input.properties.map((property) => [property.id, property.name ?? null]));

  const scopedLeads = input.leads.filter((lead) => {
    if (!lead.isActive) return false;
    if (repFilter && lead.assignedRepId !== repFilter) return false;
    return true;
  });
  const scopedDeals = input.deals.filter((deal) => {
    if (!deal.isActive) return false;
    if (repFilter && deal.assignedRepId !== repFilter) return false;
    return true;
  });

  const newOpportunities = [
    ...scopedLeads
      .filter((lead) => new Date(lead.createdAt) >= from && new Date(lead.createdAt) <= to)
      .map((lead) => ({
        entityType: "lead" as const,
        id: lead.id,
        name: lead.name,
        assignedRepId: lead.assignedRepId,
        assignedRepName: userNameMap.get(lead.assignedRepId) ?? "Unknown User",
        companyName: companyMap.get(lead.companyId) ?? null,
        propertyName: propertyMap.get(lead.propertyId) ?? null,
        createdAt: new Date(lead.createdAt).toISOString(),
        stageId: lead.stageId,
      })),
    ...scopedDeals
      .filter((deal) => new Date(deal.createdAt) >= from && new Date(deal.createdAt) <= to)
      .map((deal) => ({
        entityType: "deal" as const,
        id: deal.id,
        name: deal.name,
        assignedRepId: deal.assignedRepId,
        assignedRepName: userNameMap.get(deal.assignedRepId) ?? "Unknown User",
        companyName: deal.companyId ? (companyMap.get(deal.companyId) ?? null) : null,
        propertyName: deal.propertyId ? (propertyMap.get(deal.propertyId) ?? null) : null,
        createdAt: new Date(deal.createdAt).toISOString(),
        stageId: deal.stageId,
      })),
  ].sort((left, right) => right.createdAt.localeCompare(left.createdAt));

  const forecast: SalesReviewForecastRow[] = [
    ...scopedLeads
      .filter((lead) => !filters.forecastWindow || lead.forecastWindow === filters.forecastWindow)
      .filter((lead) => lead.forecastWindow)
      .map((lead) => ({
        entityType: "lead" as const,
        id: lead.id,
        name: lead.name,
        companyId: lead.companyId,
        companyName: companyMap.get(lead.companyId) ?? null,
        propertyId: lead.propertyId,
        propertyName: propertyMap.get(lead.propertyId) ?? null,
        stageId: lead.stageId,
        assignedRepId: lead.assignedRepId,
        assignedRepName: userNameMap.get(lead.assignedRepId) ?? "Unknown User",
        forecastWindow: lead.forecastWindow!,
        forecastCategory: lead.forecastCategory,
        forecastConfidencePercent: lead.forecastConfidencePercent,
        forecastRevenue: toNumber(lead.forecastRevenue),
        forecastGrossProfit: toNumber(lead.forecastGrossProfit),
        forecastBlockers: lead.forecastBlockers,
        nextStep: lead.nextStep,
        nextMilestoneAt: lead.nextMilestoneAt ? new Date(lead.nextMilestoneAt).toISOString() : null,
        supportNeededType: lead.supportNeededType,
      })),
    ...scopedDeals
      .filter((deal) => !filters.forecastWindow || deal.forecastWindow === filters.forecastWindow)
      .filter((deal) => deal.forecastWindow)
      .map((deal) => ({
        entityType: "deal" as const,
        id: deal.id,
        name: deal.name,
        companyId: deal.companyId,
        companyName: deal.companyId ? (companyMap.get(deal.companyId) ?? null) : null,
        propertyId: deal.propertyId,
        propertyName: deal.propertyId ? (propertyMap.get(deal.propertyId) ?? null) : null,
        stageId: deal.stageId,
        assignedRepId: deal.assignedRepId,
        assignedRepName: userNameMap.get(deal.assignedRepId) ?? "Unknown User",
        forecastWindow: deal.forecastWindow!,
        forecastCategory: deal.forecastCategory,
        forecastConfidencePercent: deal.forecastConfidencePercent,
        forecastRevenue: toNumber(deal.forecastRevenue),
        forecastGrossProfit: toNumber(deal.forecastGrossProfit),
        forecastBlockers: deal.forecastBlockers,
        nextStep: deal.nextStep,
        nextMilestoneAt: deal.nextMilestoneAt ? new Date(deal.nextMilestoneAt).toISOString() : null,
        supportNeededType: deal.supportNeededType,
      })),
  ].sort((left, right) => {
    const leftDate = left.nextMilestoneAt ?? "9999-12-31";
    const rightDate = right.nextMilestoneAt ?? "9999-12-31";
    return leftDate.localeCompare(rightDate);
  });

  const cadenceMap = new Map<string, SalesReviewActivityCadenceRow>();
  const scopedActivities = input.activities.filter((activity) => !repFilter || activity.responsibleUserId === repFilter);
  for (const activity of scopedActivities) {
    const bucket = activityBucket(activity.type);
    if (!bucket) continue;
    const repId = activity.responsibleUserId;
    const repName = userNameMap.get(repId) ?? "Unknown User";
    const row = cadenceMap.get(repId) ?? makeCadenceRow(repId, repName);
    const ageDays = Math.floor((now.getTime() - new Date(activity.occurredAt).getTime()) / 86_400_000);
    incrementCadenceRow(row, bucket, ageDays);
    cadenceMap.set(repId, row);
  }

  const hygiene = evaluateSalesHygieneRecords(
    [
      ...scopedLeads.map((lead) => ({
        entityType: "lead" as const,
        id: lead.id,
        name: lead.name,
        assignedRepId: lead.assignedRepId,
        assignedRepName: userNameMap.get(lead.assignedRepId) ?? "Unknown User",
        stageId: lead.stageId,
        forecastWindow: lead.forecastWindow,
        forecastCategory: lead.forecastCategory,
        forecastConfidencePercent: lead.forecastConfidencePercent,
        nextStep: lead.nextStep,
        nextMilestoneAt: lead.nextMilestoneAt,
        lastActivityAt: lead.lastActivityAt,
        updatedAt: lead.updatedAt,
      })),
      ...scopedDeals.map((deal) => ({
        entityType: "deal" as const,
        id: deal.id,
        name: deal.name,
        assignedRepId: deal.assignedRepId,
        assignedRepName: userNameMap.get(deal.assignedRepId) ?? "Unknown User",
        stageId: deal.stageId,
        forecastWindow: deal.forecastWindow,
        forecastCategory: deal.forecastCategory,
        forecastConfidencePercent: deal.forecastConfidencePercent,
        nextStep: deal.nextStep,
        nextMilestoneAt: deal.nextMilestoneAt,
        lastActivityAt: deal.lastActivityAt,
        updatedAt: deal.updatedAt,
      })),
    ],
    { now }
  );

  return {
    newOpportunities,
    forecast,
    activityCadence: Array.from(cadenceMap.values()).sort((left, right) => left.repName.localeCompare(right.repName)),
    hygiene,
    supportRequests: forecast.filter((row) => Boolean(row.supportNeededType)),
  };
}

export async function getSalesReviewOverview(
  tenantDb: TenantDb,
  filters: SalesReviewFilters,
  actor: SalesReviewActor
): Promise<SalesReviewOverview> {
  const repIds = actor.role === "rep" ? [actor.userId] : filters.repId ? [filters.repId] : [];
  const dateRange = normalizeDateRange(filters);

  const [leadRows, dealRows, activityRows, userRows, companyRows, propertyRows] = await Promise.all([
    tenantDb.select().from(leads).where(repIds.length > 0 ? inArray(leads.assignedRepId, repIds) : undefined),
    tenantDb.select().from(deals).where(repIds.length > 0 ? inArray(deals.assignedRepId, repIds) : undefined),
    tenantDb
      .select()
      .from(activities)
      .where(
        and(
          repIds.length > 0 ? inArray(activities.responsibleUserId, repIds) : undefined,
          gte(activities.occurredAt, subtractDays(dateRange.to, 30))
        )
      )
      .orderBy(desc(activities.occurredAt)),
    tenantDb.select({ id: users.id, displayName: users.displayName }).from(users),
    tenantDb.select({ id: companies.id, name: companies.name }).from(companies),
    tenantDb.select({ id: properties.id, name: properties.name }).from(properties),
  ]);

  return buildSalesReviewOverview({
    actor,
    filters,
    leads: leadRows,
    deals: dealRows,
    activities: activityRows,
    users: userRows,
    companies: companyRows,
    properties: propertyRows,
  });
}
