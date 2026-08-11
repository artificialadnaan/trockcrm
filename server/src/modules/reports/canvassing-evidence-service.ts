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

/**
 * The six drillable columns: the four record kinds, the notes count, and `all`.
 *
 * `all` is the grid's default mode, where a cell shows counts.total — the four kinds summed. It has to be
 * its own evidence kind rather than an alias for one of them: sending `company` for a cell holding
 * companies AND properties AND contacts lists a fraction of the records and then reports a mismatch
 * against the figure it was opened from, on nearly every cell. That is the precise failure this drill
 * exists to make impossible, so the combined column returns a combined list.
 */
export const CANVASSING_EVIDENCE_KINDS = [...CANVASSING_KINDS, "all", "notes"] as const;
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
  /**
   * Which of the four the row is. Only meaningful for the combined `all` drill, where the list mixes
   * kinds and "Acme Roofing" alone does not say whether it is a company or a lead.
   */
  kind?: CanvassingKind;
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

/**
 * ISO-shaped AND a date that exists.
 *
 * The regex alone accepts 2026-02-30 and 2026-13-01, which survive all the way to Postgres and fail at the
 * `::date` cast — a 500 where the route means to answer 400. Round-tripping through Date is what separates
 * "looks like a date" from "is one": JS normalises 2026-02-30 to March 2, so the formatted value differs
 * from the input.
 */
function isRealCalendarDate(value: string): boolean {
  if (!ISO_DATE.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

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

  // ABSENT and INVALID are different answers, and collapsing them was a quiet widening.
  //
  // `bucketStart` omitted means "this person's whole-range total" — a real, offered drill. Falling back to
  // that for a MALFORMED value meant a stale bookmark or a crafted URL asking for one week silently
  // returned every record in the selected range, under a heading naming the week. A drill that answers a
  // different question from the one asked is the one failure this whole feature exists to prevent, so an
  // unparseable period is refused rather than reinterpreted.
  const bucketStartRaw = pick(query.bucketStart).trim();
  let bucketStart: string | undefined;
  if (bucketStartRaw.length > 0) {
    if (!isRealCalendarDate(bucketStartRaw)) {
      throw new Error("bucketStart must be a YYYY-MM-DD calendar date");
    }
    bucketStart = bucketStartRaw;
  }

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
  if (options.kind === "all") return loadCombinedEvidence(tenantDb, options);
  return loadRecordEvidence(tenantDb, options, options.kind);
}

/** Where each kind's detail page lives. Kept beside the label rules so a new kind cannot add one and not the other. */
const KIND_HREF_BASE: Record<CanvassingKind, string> = {
  company: "/companies",
  property: "/properties",
  contact: "/contacts",
  lead: "/leads",
};

/**
 * The display label and sub-label per kind. Contacts have no single name column; leads and companies do.
 *
 * Both expressions are text in every branch, which is what lets the combined drill UNION the four.
 */
function kindDisplaySql(kind: CanvassingKind, alias: SQL): { label: SQL; sublabel: SQL } {
  return {
    label:
      kind === "contact"
        ? sql`NULLIF(BTRIM(CONCAT_WS(' ', ${alias}.first_name, ${alias}.last_name)), '')`
        : sql`${alias}.name`,
    sublabel:
      kind === "property"
        ? sql`NULLIF(BTRIM(CONCAT_WS(', ', ${alias}.address, ${alias}.city)), '')`
        : kind === "contact"
          ? sql`${alias}.company_name`
          : kind === "lead"
            ? sql`${alias}.status::text`
            : sql`${alias}.category::text`,
  };
}

/** The narrowing every record drill applies on top of the shared predicate: this person, this period. */
function recordNarrowingSql(options: CanvassingEvidenceOptions, alias: SQL, tsExpr: string): SQL {
  return sql`${alias}.created_by_user_id = ${options.userId}::uuid
         AND ${bucketFilterSql(options.bucket, tsExpr, options.bucketStart)}`;
}

async function loadRecordEvidence(
  tenantDb: TenantDb,
  options: CanvassingEvidenceOptions,
  kind: CanvassingKind
): Promise<CanvassingEvidenceResult> {
  const source = canvassingKindSourceSql(kind, options);
  const alias = sql.raw(source.alias);
  const period = bucketFilterSql(options.bucket, `${source.alias}.created_at`, options.bucketStart);
  const { label, sublabel } = kindDisplaySql(kind, alias);

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

  return {
    kind,
    userId: options.userId,
    bucketStart: options.bucketStart ?? null,
    total: counted.rows[0]?.n ?? 0,
    truncated,
    restrictedToSelf: false,
    rows: kept.map((row) => ({
      id: row.id,
      kind,
      label: row.label ?? "(untitled)",
      sublabel: row.sublabel,
      occurredAt: toIso(row.created_at),
      href: `${KIND_HREF_BASE[kind]}/${row.id}`,
    })),
  };
}

/**
 * The combined drill behind an `all`-mode cell: the four record kinds in one list, newest first.
 *
 * Built as a UNION ALL over the SAME per-kind sources the single-kind drills use, which is what makes it
 * reconcile. The grid's `all` cell is counts.total, and counts.total is accumulated from those same four
 * sources in the report service — so this list and that figure are the same population by construction
 * rather than by two hand-written predicates happening to agree.
 *
 * ORDER BY carries `id` as a tiebreak: four tables can produce identical created_at values, and without a
 * total order a truncated list would drop an arbitrary row from the tie while the count kept it.
 */
async function loadCombinedEvidence(
  tenantDb: TenantDb,
  options: CanvassingEvidenceOptions
): Promise<CanvassingEvidenceResult> {
  const parts = CANVASSING_KINDS.map((kind) => {
    const source = canvassingKindSourceSql(kind, options);
    const alias = sql.raw(source.alias);
    const { label, sublabel } = kindDisplaySql(kind, alias);
    // Safe as raw: `kind` comes from the CANVASSING_KINDS literal tuple, never from the request.
    return sql`
      SELECT ${sql.raw(`'${kind}'`)}::text AS kind,
             ${alias}.id::text AS id,
             ${label} AS label,
             ${sublabel} AS sublabel,
             ${alias}.created_at
        ${canvassingKindJoinSql(kind)}
       WHERE ${source.where}
         AND ${recordNarrowingSql(options, alias, `${source.alias}.created_at`)}`;
  });
  const union = sql.join(parts, sql` UNION ALL `);

  const rows = await tenantDb.execute<{
    kind: CanvassingKind;
    id: string;
    label: string | null;
    sublabel: string | null;
    created_at: string | Date;
  }>(sql`
    SELECT * FROM (${union}) AS combined
     ORDER BY combined.created_at DESC, combined.id DESC
     LIMIT ${MAX_ROWS + 1}
  `);

  const truncated = rows.rows.length > MAX_ROWS;
  const kept = truncated ? rows.rows.slice(0, MAX_ROWS) : rows.rows;

  // Same reason as the single-kind drill: counted with the predicate, not measured off a capped list.
  const counted = await tenantDb.execute<{ n: number }>(sql`
    SELECT COUNT(*)::int AS n FROM (${union}) AS combined
  `);

  return {
    kind: "all",
    userId: options.userId,
    bucketStart: options.bucketStart ?? null,
    total: counted.rows[0]?.n ?? 0,
    truncated,
    restrictedToSelf: false,
    rows: kept.map((row) => ({
      id: row.id,
      kind: row.kind,
      label: row.label ?? "(untitled)",
      sublabel: row.sublabel,
      occurredAt: toIso(row.created_at),
      href: `${KIND_HREF_BASE[row.kind]}/${row.id}`,
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
