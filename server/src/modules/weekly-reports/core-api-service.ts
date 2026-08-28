import { WEEKLY_REPORT_DELIVERY_FAILURE_STATUSES } from "@trock-crm/shared/lib/weeklyReportDelivery";
import { AppError } from "../../middleware/error-handler.js";
import {
  canonicalizeProjectNumber,
  canonicalProjectNumberSql,
} from "../bid-board-sync/project-number.js";
import { loadWeeklyReportPdfSource } from "./pdf-service.js";
import type { QueryExecutor } from "./projects-service.js";
import type {
  CoreWeeklyReportClientContent,
  CoreWeeklyReportDealBinding,
  CoreWeeklyReportLifecycleState,
  CoreWeeklyReportListItem,
} from "./core-api-contracts.js";

const DEAL_NOT_FOUND_CODE = "core_weekly_report_deal_not_found";
const DEAL_AMBIGUOUS_CODE = "core_weekly_report_deal_ambiguous";
const DEAL_IDENTITY_CONFLICT_CODE = "core_weekly_report_deal_identity_conflict";
const DEAL_BINDING_CHANGED_CODE = "core_weekly_report_deal_binding_changed";
const REPORT_NOT_FOUND_CODE = "core_weekly_report_not_found";
const REPORT_WITHDRAWN_CODE = "core_weekly_report_withdrawn";
const REPORT_READ_CONFLICT_CODE = "core_weekly_report_read_conflict";
const REPORT_SNAPSHOT_UNAVAILABLE_CODE = "core_weekly_report_snapshot_unavailable";

const DELIVERY_FAILURE_STATUSES = [...WEEKLY_REPORT_DELIVERY_FAILURE_STATUSES];

type DealIdentityRow = {
  id: string;
  project_number: string | null;
  deal_number: string | null;
  bid_board_project_number: string | null;
  is_change_order: boolean;
  parent_deal_id: string | null;
};

function authoritativeCanonicalProjectNumber(row: DealIdentityRow): string | null {
  for (const candidate of [
    row.project_number,
    row.deal_number,
    row.bid_board_project_number,
  ]) {
    const canonical = canonicalizeProjectNumber(candidate);
    if (canonical) return canonical;
  }
  return null;
}

function dealBinding(row: DealIdentityRow): CoreWeeklyReportDealBinding {
  const canonicalProjectNumber = authoritativeCanonicalProjectNumber(row);
  if (!canonicalProjectNumber) {
    // The lookup could only have matched one of these columns. Reaching this branch means the row changed
    // between expressions or contains a value the TS/SQL normalizers disagree on; either way, fail closed.
    throw new AppError(409, "The CRM deal has no stable project number", DEAL_BINDING_CHANGED_CODE);
  }
  return { id: String(row.id), canonicalProjectNumber };
}

/**
 * Resolve a visible project number exactly the way Bid Board does, but classify change-order children
 * instead of silently allowing their shared number to become a portal project.
 */
export async function resolveCoreWeeklyReportDeal(
  client: QueryExecutor,
  projectNumber: string,
): Promise<CoreWeeklyReportDealBinding> {
  const canonical = canonicalizeProjectNumber(projectNumber);
  if (!canonical) throw new AppError(400, "projectNumber is invalid", "invalid_request");

  const result = await client.query(
    `SELECT d.id,
            d.project_number,
            d.deal_number,
            d.bid_board_project_number,
            d.is_change_order,
            d.parent_deal_id
       FROM deals d
      WHERE d.is_active = true
        AND (
          ${canonicalProjectNumberSql("d.project_number")} = $1 OR
          ${canonicalProjectNumberSql("d.deal_number")} = $1 OR
          ${canonicalProjectNumberSql("d.bid_board_project_number")} = $1
        )
      ORDER BY d.id ASC`,
    [canonical],
  );

  // A legitimate CO family is parent + any number of children sharing the number. Only the one active,
  // root, non-CO row is eligible. Two eligible rows means cross-column legacy ambiguity and must never be
  // resolved by query order. A CO-only family is indistinguishable from no project to the caller.
  const eligible = (result.rows as DealIdentityRow[]).filter(
    (row) => row.is_change_order !== true && row.parent_deal_id == null,
  );
  if (eligible.length === 0) {
    throw new AppError(404, "Weekly-report deal not found", DEAL_NOT_FOUND_CODE);
  }
  if (eligible.length > 1) {
    throw new AppError(
      409,
      "Project number resolves to more than one CRM deal",
      DEAL_AMBIGUOUS_CODE,
    );
  }
  const binding = dealBinding(eligible[0]!);
  if (binding.canonicalProjectNumber !== canonical) {
    // The established matcher deliberately considers three identity columns, but the binding returned to
    // Core must name the authoritative current project number. A stale legacy column may locate the same
    // row; it must not silently redirect B to a deal whose current identity is A.
    throw new AppError(
      409,
      "The CRM deal has conflicting project-number identities",
      DEAL_IDENTITY_CONFLICT_CODE,
    );
  }
  return binding;
}

/**
 * Revalidate and share-lock the exact deal/number pair on every list/detail call; resolution is not a
 * bearer grant. The API route keeps this query and the report read in the same office transaction.
 */
export async function requireCoreWeeklyReportDealBinding(
  client: QueryExecutor,
  dealId: string,
  canonicalProjectNumber: string,
): Promise<CoreWeeklyReportDealBinding> {
  const result = await client.query(
    `SELECT d.id,
            d.project_number,
            d.deal_number,
            d.bid_board_project_number,
            d.is_change_order,
            d.parent_deal_id
       FROM deals d
      WHERE d.id = $1::uuid
        AND d.is_active = true
        AND COALESCE(d.is_change_order, false) = false
        AND d.parent_deal_id IS NULL
      LIMIT 1
      FOR SHARE OF d`,
    [dealId],
  );
  const row = result.rows[0] as DealIdentityRow | undefined;
  if (!row) throw new AppError(404, "Weekly-report deal not found", DEAL_NOT_FOUND_CODE);
  const binding = dealBinding(row);
  if (binding.canonicalProjectNumber !== canonicalProjectNumber) {
    throw new AppError(
      409,
      "The CRM deal/project-number binding changed; resolve it again",
      DEAL_BINDING_CHANGED_CODE,
    );
  }
  return binding;
}

export interface CoreWeeklyReportPagePosition {
  weekOf: string;
  reportVersion: number;
  reportId: string;
}

export interface CoreWeeklyReportListResult {
  items: CoreWeeklyReportListItem[];
  hasMore: boolean;
  last: CoreWeeklyReportPagePosition | null;
}

function isoDate(value: unknown): string {
  if (value instanceof Date) {
    // node-postgres represents a PostgreSQL `date` as LOCAL midnight. UTC conversion can subtract a day
    // in positive-offset deployments, so preserve the driver's calendar components instead.
    const year = value.getFullYear();
    const month = String(value.getMonth() + 1).padStart(2, "0");
    const day = String(value.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
  }
  return String(value).slice(0, 10);
}

function isoTimestamp(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  const parsed = new Date(String(value));
  return parsed.toISOString();
}

function lifecycleState(row: Record<string, unknown>): CoreWeeklyReportLifecycleState {
  if (row.is_active !== true) return "withdrawn";
  return row.is_superseded === true ? "superseded" : "latest";
}

function mapListRow(row: Record<string, unknown>): CoreWeeklyReportListItem {
  return {
    id: String(row.id),
    weekOf: isoDate(row.week_of),
    version: Number(row.version),
    publicationStatus: "sent",
    lifecycleState: lifecycleState(row),
    supersededByReportId:
      typeof row.superseded_by_id === "string" ? row.superseded_by_id : null,
    sendAcceptedAt: isoTimestamp(row.send_delivered_at),
  };
}

/**
 * Keyset page of provider-accepted frozen sends with no known failure. Migration 0242 owns the live
 * NULL -> accepted `send_delivered_at` transition and samples it after the same advisory boundary used
 * by page one, so `send_delivered_at <= asOf` freezes new acceptance commits across the walk. A failure
 * verdict CRM recorded after the boundary is evaluated as it stood at that boundary, regardless of the
 * provider event's older occurrence time, so delayed provider facts cannot reshuffle later pages.
 * `(week_of, version, id)` makes ordering total even if a legacy deal has more than one setup row.
 */
export async function listCoreWeeklyReports(
  client: QueryExecutor,
  input: {
    dealId: string;
    limit: number;
    asOf: string;
    after?: CoreWeeklyReportPagePosition | null;
  },
): Promise<CoreWeeklyReportListResult> {
  const params: unknown[] = [input.dealId, input.asOf, DELIVERY_FAILURE_STATUSES];
  let afterSql = "";
  if (input.after) {
    params.push(input.after.weekOf, input.after.reportVersion, input.after.reportId);
    afterSql = `
        AND (wr.week_of, wr.version, wr.id) <
            ($4::date, $5::integer, $6::uuid)`;
  }
  params.push(input.limit + 1);
  const limitParam = `$${params.length}`;

  const result = await client.query(
    `SELECT wr.id,
            wr.weekly_report_project_id,
            wr.week_of::text AS week_of,
            wr.version,
            wr.send_delivered_at,
            wr.is_active,
            successor.id AS superseded_by_id,
            successor.id IS NOT NULL AS is_superseded
       FROM weekly_reports wr
       LEFT JOIN LATERAL (
         SELECT newer.id
           FROM weekly_reports newer
          WHERE newer.deal_id = wr.deal_id
            AND newer.weekly_report_project_id = wr.weekly_report_project_id
            AND newer.week_of = wr.week_of
            AND newer.status = 'sent'
            AND newer.sent_at IS NOT NULL
            AND newer.send_delivered_at IS NOT NULL
            AND newer.send_delivered_at <= $2::timestamptz
            AND (
              newer.send_delivery_status IS NULL
              OR NOT (newer.send_delivery_status = ANY($3::text[]))
              OR newer.send_delivery_status_recorded_at > $2::timestamptz
            )
            AND newer.snapshot IS NOT NULL
            AND (newer.version, newer.id) > (wr.version, wr.id)
          ORDER BY newer.version ASC, newer.id ASC
          LIMIT 1
       ) successor ON true
      WHERE wr.deal_id = $1::uuid
        AND wr.status = 'sent'
        AND wr.sent_at IS NOT NULL
        AND wr.send_delivered_at IS NOT NULL
        AND wr.send_delivered_at <= $2::timestamptz
        AND (
          wr.send_delivery_status IS NULL
          OR NOT (wr.send_delivery_status = ANY($3::text[]))
          OR wr.send_delivery_status_recorded_at > $2::timestamptz
        )
        AND wr.snapshot IS NOT NULL${afterSql}
      ORDER BY wr.week_of DESC, wr.version DESC, wr.id DESC
      LIMIT ${limitParam}::integer`,
    params,
  );
  const pageRows = (result.rows as Array<Record<string, unknown>>).slice(0, input.limit);
  const lastRow = pageRows.at(-1);
  return {
    items: pageRows.map(mapListRow),
    hasMore: result.rows.length > input.limit,
    last: lastRow
      ? {
          weekOf: isoDate(lastRow.week_of),
          reportVersion: Number(lastRow.version),
          reportId: String(lastRow.id),
        }
      : null,
  };
}

async function reportSupersession(
  client: QueryExecutor,
  row: Record<string, unknown>,
): Promise<{
  lifecycleState: CoreWeeklyReportLifecycleState;
  supersededByReportId: string | null;
}> {
  if (row.is_active !== true) {
    return { lifecycleState: "withdrawn", supersededByReportId: null };
  }
  const newer = await client.query(
    `SELECT candidate.id
       FROM weekly_reports candidate
      WHERE candidate.deal_id = $1::uuid
        AND candidate.weekly_report_project_id = $2::uuid
        AND candidate.week_of = $3::date
        AND candidate.status = 'sent'
        AND candidate.sent_at IS NOT NULL
        AND candidate.send_delivered_at IS NOT NULL
        AND (candidate.send_delivery_status IS NULL
             OR NOT (candidate.send_delivery_status = ANY($6::text[])))
        AND candidate.snapshot IS NOT NULL
        AND (candidate.version, candidate.id) > ($4::integer, $5::uuid)
      ORDER BY candidate.version ASC, candidate.id ASC
      LIMIT 1`,
    [
      row.deal_id,
      row.weekly_report_project_id,
      isoDate(row.week_of),
      Number(row.version),
      row.id,
      DELIVERY_FAILURE_STATUSES,
    ],
  );
  const successorId = newer.rows[0]?.id;
  return successorId
    ? { lifecycleState: "superseded", supersededByReportId: String(successorId) }
    : { lifecycleState: "latest", supersededByReportId: null };
}

export interface CoreWeeklyReportDetailResult {
  item: CoreWeeklyReportListItem;
  content: CoreWeeklyReportClientContent;
}

/**
 * Load through the exact source used by the PDF/public viewer, then copy only named client-safe fields.
 * In particular, never return the source object or spread its photo rows: those contain R2 keys and raw
 * external URLs. A withdrawn report is identifiable but its retained narrative never crosses this API.
 */
export async function getCoreWeeklyReportDetail(
  client: QueryExecutor,
  input: { dealId: string; reportId: string },
): Promise<CoreWeeklyReportDetailResult> {
  // The service-auth route calls this inside one `withWeeklyReportOfficeClient` transaction. FOR SHARE
  // therefore holds the eligibility fact (active, provider-accepted, no known failure, frozen snapshot)
  // through the canonical loader and response projection. A concurrent withdrawal/failure waits for this
  // read to commit instead of changing the row between authorization and narrative extraction.
  const eligible = await client.query(
    `SELECT wr.id,
            wr.deal_id,
            wr.weekly_report_project_id,
            wr.week_of::text AS week_of,
            wr.version,
            wr.send_delivered_at,
            wr.is_active
       FROM weekly_reports wr
      WHERE wr.id = $1::uuid
        AND wr.deal_id = $2::uuid
        AND wr.status = 'sent'
        AND wr.sent_at IS NOT NULL
        AND wr.send_delivered_at IS NOT NULL
        AND (wr.send_delivery_status IS NULL
             OR NOT (wr.send_delivery_status = ANY($3::text[])))
        AND wr.snapshot IS NOT NULL
      LIMIT 1
      FOR SHARE OF wr`,
    [input.reportId, input.dealId, DELIVERY_FAILURE_STATUSES],
  );
  const row = eligible.rows[0] as Record<string, unknown> | undefined;
  if (!row) throw new AppError(404, "Weekly report not found", REPORT_NOT_FOUND_CODE);
  if (row.is_active !== true) {
    throw new AppError(410, "Weekly report was withdrawn", REPORT_WITHDRAWN_CODE);
  }

  const source = await loadWeeklyReportPdfSource(client, input.reportId);
  if (!source || source.dealId !== input.dealId) {
    // The service-auth route's transaction/shared lock prevents this race. Keep the guard for any direct
    // caller that fails to supply that envelope: a changed row is never permission to use retained raw
    // columns. The generic conflict makes the caller re-list and learn the terminal state there.
    throw new AppError(
      409,
      "Weekly report changed while it was being read",
      REPORT_READ_CONFLICT_CODE,
    );
  }
  const view = source.view;
  if (view.status !== "sent" || !view.sentAt || !view.fromSnapshot) {
    throw new AppError(
      409,
      "Sent report snapshot is unavailable",
      REPORT_SNAPSHOT_UNAVAILABLE_CODE,
    );
  }

  const pdf = view.pdf;
  const supersession = await reportSupersession(client, row);
  return {
    item: {
      id: String(row.id),
      weekOf: view.weekOf,
      version: Number(row.version),
      publicationStatus: "sent",
      lifecycleState: supersession.lifecycleState,
      supersededByReportId: supersession.supersededByReportId,
      sendAcceptedAt: isoTimestamp(row.send_delivered_at),
    },
    content: {
      // Legacy snapshots may lack propertyDisplayName. The canonical PDF/public view then falls back to
      // today's deals.name; that live value is correct for those existing surfaces but cannot be labeled
      // frozen in this contract. Preserve readability and fail the one field closed instead.
      propertyName: view.propertyNameFromDeal ? null : pdf.propertyName,
      weekOfLabel: pdf.weekOfLabel,
      clientName: pdf.clientName,
      clientTeam: pdf.clientTeam.map((contact) => ({
        label: contact.label,
        name: contact.name,
      })),
      trockTeam: pdf.trockTeam.map((contact) => ({
        label: contact.label,
        name: contact.name,
      })),
      workCompleted: pdf.workCompleted,
      nextWeekLookAhead: pdf.nextWeekLookAhead,
      issuesConcerns: pdf.issuesConcerns,
      schedule: {
        contractDate: pdf.schedule.contractDate,
        projectStartDate: pdf.schedule.projectStartDate,
        projectCompletionDate: pdf.schedule.projectCompletionDate,
        completionPercent: pdf.schedule.completionPercent,
        weatherDelayDays: pdf.schedule.weatherDelayDays,
      },
      duration: {
        projectedWeeks: pdf.duration.projectedWeeks,
        remainingWeeks: pdf.duration.remainingWeeks,
      },
      // Ordered by the canonical loader's report sort order. The ordinal is deliberately normalized to a
      // dense zero-based value; the raw link-row id and every storage locator remain private.
      photos: pdf.photos.map((photo, sortOrder) => ({
        fileId: photo.fileId,
        caption: photo.caption,
        sortOrder,
      })),
    },
  };
}
