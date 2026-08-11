// Drill-to-evidence for the Canvassing Activity report: the actual records behind ONE number.
//
// The rule this file exists to keep is reconciliation. A drill whose list does not add up to the figure it
// was opened from is worse than no drill at all — it teaches a reader that the report's numbers cannot be
// checked. So the row source, and every rule that decides whether a row counts, is imported from
// canvassing-activity-service.ts (canvassingKindSourceSql) rather than restated here. The two cannot
// disagree, because there is only one of them.
//
// The narrowing on top of that shared predicate is exactly the cell that was clicked:
//   userId      — whose row (required; the scoreboard has no office-wide cell to drill)
//   bucketStart — which period column, or absent for that person's whole-range total
//   kind        — which column: one of the four record types, or the notes count
//
// ACCESS is the report's own: the same allowlist guards the route, and a `rep` viewer drilling NOTES sees
// only their own, matching the feed. The counts a rep can see are office-wide; the note TEXT is not, and a
// drill must not become the way around that.

import { sql, type SQL } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type * as schema from "@trock-crm/shared/schema";
import {
  CANVASSING_BUCKETS,
  CANVASSING_KINDS,
  canvassingKindJoinSql,
  canvassingKindSourceSql,
  type CanvassingBucket,
  type CanvassingKind,
} from "./canvassing-activity-service.js";

type TenantDb = NodePgDatabase<typeof schema>;

/** The five drillable columns: the four record kinds, plus the notes count. */
export const CANVASSING_EVIDENCE_KINDS = [...CANVASSING_KINDS, "notes"] as const;
export type CanvassingEvidenceKind = (typeof CANVASSING_EVIDENCE_KINDS)[number];

export interface CanvassingEvidenceOptions {
  kind: CanvassingEvidenceKind;
  userId: string;
  /** A single period column, or absent for the person's whole-range total. */
  bucketStart?: string;
  bucket: CanvassingBucket;
  dateFrom: string;
  dateTo: string;
  officeId?: string | null;
  /** The HOME role, for the same notes restriction the report's feed applies. */
  viewerRole?: string | null;
  viewerEffectiveRole?: string | null;
  viewerUserId?: string | null;
}

export interface CanvassingEvidenceRecord {
  id: string;
  label: string;
  sublabel: string | null;
  occurredAt: string;
  href: string | null;
}

export interface CanvassingEvidenceResult {
  kind: CanvassingEvidenceKind;
  userId: string;
  bucketStart: string | null;
  /** The number this drill was opened from. `rows.length` equals it unless `truncated`. */
  total: number;
  rows: CanvassingEvidenceRecord[];
  truncated: boolean;
  /** The rows were narrowed to the viewer's own notes; `total` still describes everyone's. */
  restrictedToSelf: boolean;
}

const MAX_ROWS = 500;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function parseCanvassingEvidenceParams(query: Record<string, unknown>): {
  kind: CanvassingEvidenceKind;
  userId: string;
  bucketStart?: string;
  bucket: CanvassingBucket;
} {
  const pick = (value: unknown): string =>
    Array.isArray(value) ? (typeof value[0] === "string" ? value[0] : "") : typeof value === "string" ? value : "";

  const kindRaw = pick(query.kind).trim();
  if (!(CANVASSING_EVIDENCE_KINDS as readonly string[]).includes(kindRaw)) {
    throw new Error(`kind must be one of: ${CANVASSING_EVIDENCE_KINDS.join(", ")}`);
  }
  const userId = pick(query.userId).trim();
  if (!UUID.test(userId)) throw new Error("userId must be a UUID");

  const bucketRaw = pick(query.bucket).trim().toLowerCase();
  const bucket = (CANVASSING_BUCKETS as readonly string[]).includes(bucketRaw)
    ? (bucketRaw as CanvassingBucket)
    : "week";

  const bucketStartRaw = pick(query.bucketStart).trim();
  const bucketStart = ISO_DATE.test(bucketStartRaw) ? bucketStartRaw : undefined;

  return { kind: kindRaw as CanvassingEvidenceKind, userId, bucketStart, bucket };
}

/**
 * The period narrowing, expressed on the same bucket expression the report groups by.
 *
 * Deliberately compares the BUCKET rather than adding a second date range: a drill built from its own
 * window would round the edges differently from the column it came from, which is precisely the class of
 * near-miss that makes a drill untrustworthy.
 */
function bucketFilterSql(bucket: CanvassingBucket, tsExpr: string, bucketStart?: string): SQL {
  if (!bucketStart) return sql`TRUE`;
  const bucketExpr =
    bucket === "week"
      ? sql.raw(`(date_trunc('week', (((${tsExpr}) AT TIME ZONE 'America/Chicago') + interval '1 day')) - interval '1 day')::date`)
      : sql.raw(`(date_trunc('${bucket}', ((${tsExpr}) AT TIME ZONE 'America/Chicago')))::date`);
  return sql`${bucketExpr} = ${bucketStart}::date`;
}

export async function getCanvassingEvidence(
  tenantDb: TenantDb,
  options: CanvassingEvidenceOptions
): Promise<CanvassingEvidenceResult> {
  if (options.kind === "notes") return loadNoteEvidence(tenantDb, options);
  return loadRecordEvidence(tenantDb, options, options.kind);
}

async function loadRecordEvidence(
  tenantDb: TenantDb,
  options: CanvassingEvidenceOptions,
  kind: CanvassingKind
): Promise<CanvassingEvidenceResult> {
  const source = canvassingKindSourceSql(kind, options);
  const alias = sql.raw(source.alias);
  const period = bucketFilterSql(options.bucket, `${source.alias}.created_at`, options.bucketStart);

  // The display label per kind. Contacts have no single name column; leads and companies do.
  const label =
    kind === "contact"
      ? sql`NULLIF(BTRIM(CONCAT_WS(' ', ${alias}.first_name, ${alias}.last_name)), '')`
      : sql`${alias}.name`;
  const sublabel =
    kind === "property"
      ? sql`NULLIF(BTRIM(CONCAT_WS(', ', ${alias}.address, ${alias}.city)), '')`
      : kind === "contact"
        ? sql`${alias}.company_name`
        : kind === "lead"
          ? sql`${alias}.status::text`
          : sql`${alias}.category::text`;

  const rows = await tenantDb.execute<{ id: string; label: string | null; sublabel: string | null; created_at: string | Date }>(sql`
    SELECT ${alias}.id::text AS id, ${label} AS label, ${sublabel} AS sublabel, ${alias}.created_at
      ${canvassingKindJoinSql(kind)}
     WHERE ${source.where}
       AND ${alias}.created_by_user_id = ${options.userId}::uuid
       AND ${period}
     ORDER BY ${alias}.created_at DESC
     LIMIT ${MAX_ROWS + 1}
  `);

  const truncated = rows.rows.length > MAX_ROWS;
  const kept = truncated ? rows.rows.slice(0, MAX_ROWS) : rows.rows;

  // Counted with the SAME predicate rather than taken from rows.length, so a truncated drill still reports
  // the figure it was opened from instead of silently reporting the cap.
  const counted = await tenantDb.execute<{ n: number }>(sql`
    SELECT COUNT(*)::int AS n
      ${canvassingKindJoinSql(kind)}
     WHERE ${source.where}
       AND ${alias}.created_by_user_id = ${options.userId}::uuid
       AND ${period}
  `);

  const base = { company: "/companies", property: "/properties", contact: "/contacts", lead: "/leads" }[kind];
  return {
    kind,
    userId: options.userId,
    bucketStart: options.bucketStart ?? null,
    total: counted.rows[0]?.n ?? 0,
    truncated,
    restrictedToSelf: false,
    rows: kept.map((row) => ({
      id: row.id,
      label: row.label ?? "(untitled)",
      sublabel: row.sublabel,
      occurredAt: toIso(row.created_at),
      href: `${base}/${row.id}`,
    })),
  };
}

async function loadNoteEvidence(
  tenantDb: TenantDb,
  options: CanvassingEvidenceOptions
): Promise<CanvassingEvidenceResult> {
  const period = bucketFilterSql(options.bucket, "a.occurred_at", options.bucketStart);
  const window = sql`(((a.occurred_at) AT TIME ZONE 'America/Chicago')::date) BETWEEN ${options.dateFrom}::date AND ${options.dateTo}::date`;

  // Same rules as the report's own notes queries: notes only, no test author, no test performer, and not
  // attached to a test record.
  const base = sql`
    FROM activities a
    JOIN users u            ON u.id  = a.responsible_user_id
    LEFT JOIN companies co  ON co.id = a.company_id
    LEFT JOIN properties pr ON pr.id = a.property_id
    LEFT JOIN contacts ct   ON ct.id = a.contact_id
    LEFT JOIN leads le      ON le.id = a.lead_id
    LEFT JOIN deals de      ON de.id = a.deal_id
   WHERE a.responsible_user_id = ${options.userId}::uuid
     AND a.type = 'note'
     AND COALESCE(u.is_test_data, false) = false
     AND NOT EXISTS (SELECT 1 FROM users pfu WHERE pfu.id = a.performed_by_user_id AND pfu.is_test_data = true)
     AND NOT EXISTS (SELECT 1 FROM companies tc WHERE tc.id = a.company_id AND tc.is_test_data = true)
     AND NOT EXISTS (SELECT 1 FROM properties tp WHERE tp.id = a.property_id AND tp.is_test_data = true)
     AND NOT EXISTS (SELECT 1 FROM contacts tct WHERE tct.id = a.contact_id AND tct.is_test_data = true)
     AND NOT EXISTS (SELECT 1 FROM leads tl WHERE tl.id = a.lead_id AND tl.is_test_data = true)
     AND NOT EXISTS (SELECT 1 FROM deals td WHERE td.id = a.deal_id AND td.is_test_data = true)
     AND ${window}
     AND ${period}`;

  const counted = await tenantDb.execute<{ n: number }>(sql`SELECT COUNT(*)::int AS n ${base}`);

  // A rep may read only their OWN note text — the same line the report's feed draws. The COUNT above stays
  // office-wide, so drilling a colleague's notes cell shows the right number and no text, rather than
  // becoming a way around the boundary.
  const restrictToSelf = options.viewerRole === "rep" || options.viewerEffectiveRole === "rep";
  const mayRead = !restrictToSelf || options.viewerUserId === options.userId;

  if (!mayRead) {
    return {
      kind: "notes",
      userId: options.userId,
      bucketStart: options.bucketStart ?? null,
      total: counted.rows[0]?.n ?? 0,
      rows: [],
      truncated: false,
      restrictedToSelf: true,
    };
  }

  const rows = await tenantDb.execute<{ id: string; subject: string | null; body: string | null; occurred_at: string | Date; target: string | null }>(sql`
    SELECT a.id::text AS id,
           a.subject,
           a.body,
           a.occurred_at,
           COALESCE(de.name, NULLIF(BTRIM(CONCAT_WS(' ', ct.first_name, ct.last_name)), ''), co.name, le.name, pr.name) AS target
    ${base}
     ORDER BY a.occurred_at DESC, a.id DESC
     LIMIT ${MAX_ROWS + 1}
  `);

  const truncated = rows.rows.length > MAX_ROWS;
  const kept = truncated ? rows.rows.slice(0, MAX_ROWS) : rows.rows;

  return {
    kind: "notes",
    userId: options.userId,
    bucketStart: options.bucketStart ?? null,
    total: counted.rows[0]?.n ?? 0,
    truncated,
    restrictedToSelf: restrictToSelf,
    rows: kept.map((row) => ({
      id: row.id,
      label: row.subject ?? "(no subject)",
      sublabel: row.body,
      occurredAt: toIso(row.occurred_at),
      href: null,
    })),
  };
}

function toIso(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : new Date(String(value)).toISOString();
}
