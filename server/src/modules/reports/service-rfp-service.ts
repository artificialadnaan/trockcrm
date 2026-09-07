import { sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type * as schema from "@trock-crm/shared/schema";
import type { ServiceRfpReport, ServiceRfpReportDeal } from "@trock-crm/shared/types";
import { AppError } from "../../middleware/error-handler.js";
import { getRepRosterOptions } from "../dashboard/service.js";
import { aliasedIsServiceProjectSql } from "../shared/deal-value-sql.js";
import { buildOfficeExistsMatcher } from "./office-filter.js";
import type { SalesReportFilters } from "./sales-tier1-service.js";
import { serviceRfpJobSql } from "../deals/service-rfp-submission.js";

export function chicagoDate(value: string | Date): string {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: "America/Chicago", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(value));
  const part = (type: string) => parts.find((p) => p.type === type)!.value;
  return `${part("year")}-${part("month")}-${part("day")}`;
}

export function mondayOf(date: string): string {
  const value = new Date(`${date}T12:00:00Z`);
  value.setUTCDate(value.getUTCDate() - (value.getUTCDay() + 6) % 7);
  return value.toISOString().slice(0, 10);
}

export function assertServiceRfpRange(from: string, to: string) {
  for (const date of [from, to]) {
    const parsed = new Date(`${date}T00:00:00Z`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) {
      throw new AppError(400, "Choose valid start and end dates (YYYY-MM-DD)");
    }
  }
  if (from > to) throw new AppError(400, "Start date must be on or before end date");
  if (new Date(to).getTime() - new Date(from).getTime() > 3660 * 86400000) throw new AppError(400, "Choose a report range of 10 years or less");
}

export function summarizeServiceRfps(
  rows: ServiceRfpReportDeal[],
  roster: Array<{ id: string; displayName: string }>,
  dateFrom: string,
  dateTo: string,
): ServiceRfpReport {
  assertServiceRfpRange(dateFrom, dateTo);
  const weeks: string[] = [];
  for (let day = new Date(`${mondayOf(dateFrom)}T12:00:00Z`); day.toISOString().slice(0, 10) <= dateTo; day.setUTCDate(day.getUTCDate() + 7)) {
    weeks.push(day.toISOString().slice(0, 10));
  }
  const people = new Map<string | null, ServiceRfpReport["reps"][number]>();
  const addPerson = (repId: string | null, repName: string) => {
    if (!people.has(repId)) people.set(repId, { repId, repName, total: 0, weekly: Object.fromEntries(weeks.map((week) => [week, 0])) });
    return people.get(repId)!;
  };
  roster.forEach((rep) => addPerson(rep.id, rep.displayName));
  const seen = new Set<string>();
  const deals: ServiceRfpReportDeal[] = [];
  const missingEvidence: ServiceRfpReportDeal[] = [];
  for (const row of rows) {
    if (seen.has(row.dealId)) continue;
    seen.add(row.dealId);
    if (!row.submittedAt) { missingEvidence.push(row); continue; }
    const localDate = chicagoDate(row.submittedAt);
    if (localDate < dateFrom || localDate > dateTo) continue;
    const week = mondayOf(localDate);
    const person = addPerson(row.repId, row.repName);
    person.total++;
    person.weekly[week] = (person.weekly[week] ?? 0) + 1;
    deals.push({ ...row, week });
  }
  return {
    dateFrom, dateTo, timezone: "America/Chicago", weeks,
    total: deals.length, historicalCount: deals.filter((row) => row.basis === "historical").length,
    missingEvidenceCount: missingEvidence.length,
    reps: [...people.values()].sort((a, b) => b.total - a.total || a.repName.localeCompare(b.repName)),
    deals, missingEvidence,
  };
}

export async function getServiceRfpReport(db: NodePgDatabase<typeof schema>, filters: SalesReportFilters, officeId: string) {
  assertServiceRfpRange(filters.dateFrom, filters.dateTo);
  const officeFilter = buildOfficeExistsMatcher(filters.officeSlug);
  const result = await db.execute(sql`
    WITH retained_rfps AS (
      SELECT q.payload->>'dealId' AS deal_id, MIN(q.created_at) AS submitted_at
      FROM public.job_queue q
      WHERE q.office_id = ${officeId}::uuid
        AND q.job_type IN ('rfp_request_delivery', 'rfp_bidboard_create')
        AND ${serviceRfpJobSql("q")}
      GROUP BY q.payload->>'dealId'
    )
    SELECT d.id AS "dealId", d.name AS "dealName", d.is_active AS "isActive",
      CASE WHEN s.deal_id IS NOT NULL THEN s.assigned_rep_id ELSE d.assigned_rep_id END AS "repId",
      CASE WHEN s.deal_id IS NOT NULL THEN COALESCE(s.assigned_rep_name, 'Unattributed')
           ELSE COALESCE(u.display_name, 'Unattributed') END AS "repName",
      u.email AS "repEmail",
      COALESCE(s.submitted_at, h.submitted_at) AS "submittedAt",
      CASE WHEN s.deal_id IS NOT NULL THEN s.evidence_basis
           WHEN h.submitted_at IS NOT NULL THEN 'historical'
           ELSE 'missing' END AS basis
    FROM deals d
    LEFT JOIN public.service_rfp_submissions s ON s.deal_id = d.id AND s.office_id = ${officeId}::uuid
    LEFT JOIN retained_rfps h ON h.deal_id = d.id::text
    LEFT JOIN public.users u ON u.id = CASE WHEN s.deal_id IS NOT NULL THEN s.assigned_rep_id ELSE d.assigned_rep_id END
    WHERE COALESCE(d.is_test_data, false) = false
      AND (${aliasedIsServiceProjectSql("d")} OR s.deal_id IS NOT NULL OR h.deal_id IS NOT NULL)
      AND ${officeFilter ?? sql`TRUE`}
    ORDER BY COALESCE(s.submitted_at, h.submitted_at) DESC NULLS LAST, d.id
  `);
  const matchesOwner = (id: string | null, name: string, email?: string | null) => {
    if (!filters.ownerIds.length && !filters.ownerNames.length && !filters.ownerEmails.length) return true;
    return filters.ownerIds.includes(id ?? "__unassigned__") || filters.ownerNames.includes(name) || filters.ownerEmails.includes((email ?? "").toLowerCase());
  };
  const raw = (Array.isArray(result) ? result : result.rows) as Array<ServiceRfpReportDeal & { repEmail?: string | null }>;
  const rows = raw.filter((row) => matchesOwner(row.repId, row.repName, row.repEmail)).map((row) => ({
    dealId: row.dealId, dealName: row.dealName, isActive: row.isActive, repId: row.repId, repName: row.repName,
    submittedAt: row.submittedAt ? new Date(row.submittedAt).toISOString() : null, basis: row.basis, week: null,
  }));
  const salesRoster = (await getRepRosterOptions(db, officeId)).filter((rep) => rep.group === "sales");
  // The canonical roster deliberately exposes no email. Resolve email filters only within its
  // already office-scoped IDs so eligible zero-contribution sellers match just like deal owners.
  const emailOwnerIds = new Set<string>();
  if (filters.ownerEmails.length && salesRoster.length) {
    const emailResult = await db.execute(sql`
      SELECT id FROM public.users
      WHERE id IN (${sql.join(salesRoster.map((rep) => sql`${rep.id}::uuid`), sql`, `)})
        AND lower(email) IN (${sql.join(filters.ownerEmails.map((email) => sql`${email}`), sql`, `)})
    `);
    const emailRows = (Array.isArray(emailResult) ? emailResult : emailResult.rows) as Array<{ id: string }>;
    emailRows.forEach((row) => emailOwnerIds.add(row.id));
  }
  const roster = salesRoster.filter((rep) => matchesOwner(rep.id, rep.displayName) || emailOwnerIds.has(rep.id));
  return summarizeServiceRfps(rows, roster, filters.dateFrom, filters.dateTo);
}
