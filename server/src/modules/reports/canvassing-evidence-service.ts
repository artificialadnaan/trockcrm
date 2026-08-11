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
  bucketSql,
  businessWindowSql,
  isRealIsoDate,
  NOTES_ONLY,
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
 *
 * `unattributed` is the "No author recorded" column — the same four tables, but the rows whose creator
 * was never recorded. It is the one figure on the page a reader most needs to inspect, because the whole
 * report turns on telling "nobody did anything" apart from "nobody was recorded doing it".
 */
export const CANVASSING_EVIDENCE_KINDS = [...CANVASSING_KINDS, "all", "unattributed", "notes"] as const;
export type CanvassingEvidenceKind = (typeof CANVASSING_EVIDENCE_KINDS)[number];

export interface CanvassingEvidenceOptions {
  kind: CanvassingEvidenceKind;
  /**
   * Whose cell, or ABSENT for an office-wide figure.
   *
   * The per-person scoreboard is not the only place this report prints a number: the KPI cards and the
   * "Office totals by period" table are office-wide, and leaving them undrillable left a large share of
   * the page's figures unable to answer "which records is this?".
   */
  userId?: string;
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
  /**
   * What a NOTE was attached to — the deal, contact, company, lead or property it documents.
   *
   * The query already resolved it and the mapping used to drop it, leaving a note with a generic or
   * empty subject with nothing at all to identify the work it records, and no link to recover it from.
   */
  attachedTo?: string | null;
}

export interface CanvassingEvidenceResult {
  kind: CanvassingEvidenceKind;
  /** Null for an office-wide drill. */
  userId: string | null;
  bucketStart: string | null;
  /** The number this drill was opened from. `rows.length` equals it unless `truncated`. */
  total: number;
  rows: CanvassingEvidenceRecord[];
  truncated: boolean;
  /** The rows were narrowed to the viewer's own notes; `total` still describes everyone's. */
  restrictedToSelf: boolean;
}

const MAX_ROWS = 500;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;


export function parseCanvassingEvidenceParams(query: Record<string, unknown>): {
  kind: CanvassingEvidenceKind;
  userId?: string;
  bucketStart?: string;
  bucket: CanvassingBucket;
} {
  const pick = (value: unknown): string =>
    Array.isArray(value) ? (typeof value[0] === "string" ? value[0] : "") : typeof value === "string" ? value : "";

  const kindRaw = pick(query.kind).trim();
  if (!(CANVASSING_EVIDENCE_KINDS as readonly string[]).includes(kindRaw)) {
    throw new Error(`kind must be one of: ${CANVASSING_EVIDENCE_KINDS.join(", ")}`);
  }
  // OPTIONAL now: absent means an office-wide figure (a KPI card or an "Office totals by period" cell).
  // Present-but-malformed is still refused, for the same reason a malformed bucketStart is — silently
  // widening a person's drill to the whole office answers a different question from the one asked.
  const userIdRaw = pick(query.userId).trim();
  let userId: string | undefined;
  if (userIdRaw.length > 0) {
    if (!UUID.test(userIdRaw)) throw new Error("userId must be a UUID");
    userId = userIdRaw;
  }

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
    if (!isRealIsoDate(bucketStartRaw)) {
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
  // The report's OWN bucket expression, imported rather than restated. The copy that used to live here
  // had already drifted in a small way — it hardcoded the timezone instead of reading BUSINESS_TIMEZONE
  // — and the module header above claims the drill repeats none of these rules. It does now.
  return sql`${bucketSql(bucket, tsExpr)} = ${bucketStart}::date`;
}

export async function getCanvassingEvidence(
  tenantDb: TenantDb,
  options: CanvassingEvidenceOptions
): Promise<CanvassingEvidenceResult> {
  if (options.kind === "notes") return loadNoteEvidence(tenantDb, options);
  if (options.kind === "all") return loadCombinedEvidence(tenantDb, options, "attributed");
  if (options.kind === "unattributed") return loadCombinedEvidence(tenantDb, options, "unattributed");
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

/**
 * The narrowing every record drill applies on top of the shared predicate: this period, and — when the
 * cell belongs to one person — that person. An office-wide cell narrows by period alone.
 *
 * Attribution still applies office-wide: rows with no creator are the UNATTRIBUTED count the report
 * reports separately, never part of a person-sum, so they stay out of both.
 */
function recordNarrowingSql(options: CanvassingEvidenceOptions, alias: SQL, tsExpr: string): SQL {
  const person = options.userId
    ? sql`${alias}.created_by_user_id = ${options.userId}::uuid`
    : sql`${alias}.created_by_user_id IS NOT NULL`;
  return sql`${person}
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

  // ONE statement for both the rows and the total. Window functions are evaluated BEFORE LIMIT, so
  // COUNT(*) OVER () is the full count even on a truncated page — and, unlike a second query, it cannot
  // describe a different population. Under READ COMMITTED a note or record inserted between two separate
  // statements would leave `total` describing the old set and `rows` the new one, so the dialog would
  // report a reconciliation it had not actually performed.
  const rows = await tenantDb.execute<{ id: string; label: string | null; sublabel: string | null; created_at: string | Date; total_count: number }>(sql`
    SELECT ${alias}.id::text AS id, ${label} AS label, ${sublabel} AS sublabel, ${alias}.created_at,
           COUNT(*) OVER ()::int AS total_count
      ${canvassingKindJoinSql(kind)}
     WHERE ${source.where}
       AND ${recordNarrowingSql(options, alias, `${source.alias}.created_at`)}
     ORDER BY ${alias}.created_at DESC
     LIMIT ${MAX_ROWS + 1}
  `);

  const truncated = rows.rows.length > MAX_ROWS;
  const kept = truncated ? rows.rows.slice(0, MAX_ROWS) : rows.rows;

  return {
    kind,
    userId: options.userId ?? null,
    bucketStart: options.bucketStart ?? null,
    total: rows.rows[0]?.total_count ?? 0,
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
  options: CanvassingEvidenceOptions,
  /**
   * `attributed` is the combined column: rows with a recorded creator, narrowed to a person when the
   * cell belongs to one. `unattributed` is the "No author recorded" column — the same four tables, rows
   * whose creator was never recorded, and never person-narrowed because by definition there is nobody
   * to narrow to.
   */
  attribution: "attributed" | "unattributed"
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
         AND ${
           attribution === "unattributed"
             ? sql`${alias}.created_by_user_id IS NULL
         AND ${bucketFilterSql(options.bucket, `${source.alias}.created_at`, options.bucketStart)}`
             : recordNarrowingSql(options, alias, `${source.alias}.created_at`)
         }`;
  });
  const union = sql.join(parts, sql` UNION ALL `);

  // One statement, for the same snapshot reason as the single-kind drill.
  const rows = await tenantDb.execute<{
    kind: CanvassingKind;
    id: string;
    label: string | null;
    sublabel: string | null;
    created_at: string | Date;
    total_count: number;
  }>(sql`
    SELECT combined.*, COUNT(*) OVER ()::int AS total_count
      FROM (${union}) AS combined
     ORDER BY combined.created_at DESC, combined.id DESC
     LIMIT ${MAX_ROWS + 1}
  `);

  const truncated = rows.rows.length > MAX_ROWS;
  const kept = truncated ? rows.rows.slice(0, MAX_ROWS) : rows.rows;

  return {
    kind: attribution === "unattributed" ? "unattributed" : "all",
    userId: options.userId ?? null,
    bucketStart: options.bucketStart ?? null,
    total: rows.rows[0]?.total_count ?? 0,
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
  // The report's own window helper: a sargable half-open range on the bare column, not a restated
  // BETWEEN over a casted one. Two spellings of "this window" is exactly how a drill stops matching the
  // figure it was opened from at a range edge.
  const window = businessWindowSql("a.occurred_at", options.dateFrom, options.dateTo);

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
   WHERE ${NOTES_ONLY}
     ${options.userId ? sql`AND a.responsible_user_id = ${options.userId}::uuid` : sql``}
     AND COALESCE(u.is_test_data, false) = false
     AND NOT EXISTS (SELECT 1 FROM users pfu WHERE pfu.id = a.performed_by_user_id AND pfu.is_test_data = true)
     AND NOT EXISTS (SELECT 1 FROM companies tc WHERE tc.id = a.company_id AND tc.is_test_data = true)
     AND NOT EXISTS (SELECT 1 FROM properties tp WHERE tp.id = a.property_id AND tp.is_test_data = true)
     AND NOT EXISTS (SELECT 1 FROM contacts tct WHERE tct.id = a.contact_id AND tct.is_test_data = true)
     AND NOT EXISTS (SELECT 1 FROM leads tl WHERE tl.id = a.lead_id AND tl.is_test_data = true)
     AND NOT EXISTS (SELECT 1 FROM deals td WHERE td.id = a.deal_id AND td.is_test_data = true)
     AND ${window}
     AND ${period}`;

  // A rep may read only their OWN note text — the same line the report's feed draws. The COUNT above stays
  // office-wide, so drilling a colleague's notes cell shows the right number and no text, rather than
  // becoming a way around the boundary.
  const restrictToSelf = options.viewerRole === "rep" || options.viewerEffectiveRole === "rep";
  // A rep reads only their OWN note text. On an office-wide drill there is no single person to be, so a
  // rep gets the count and no text at all — the same boundary the feed draws, not a hole beside it.
  const mayRead = !restrictToSelf || (options.userId != null && options.viewerUserId === options.userId);

  // ONE statement for the rows AND the total, so the two cannot describe different populations — under
  // READ COMMITTED a note inserted or deleted between two separate queries would leave the dialog
  // claiming a reconciliation it never performed. COUNT(*) OVER () is evaluated before LIMIT, so the
  // total is the whole set even on a truncated page.
  const rows = await tenantDb.execute<{ id: string; subject: string | null; body: string | null; occurred_at: string | Date; target: string | null; total_count: number }>(sql`
    SELECT a.id::text AS id,
           a.subject,
           a.body,
           a.occurred_at,
           COALESCE(de.name, NULLIF(BTRIM(CONCAT_WS(' ', ct.first_name, ct.last_name)), ''), co.name, le.name, pr.name) AS target,
           COUNT(*) OVER ()::int AS total_count
    ${base}
     ORDER BY a.occurred_at DESC, a.id DESC
     LIMIT ${MAX_ROWS + 1}
  `);

  const total = rows.rows[0]?.total_count ?? 0;
  const truncated = rows.rows.length > MAX_ROWS;
  const kept = truncated ? rows.rows.slice(0, MAX_ROWS) : rows.rows;

  // The COUNT stays office-wide either way; only the TEXT is withheld. Discarding the rows here rather
  // than running a separate count keeps the number and the withheld set on one snapshot.
  if (!mayRead) {
    return {
      kind: "notes",
      userId: options.userId ?? null,
      bucketStart: options.bucketStart ?? null,
      total,
      rows: [],
      truncated: false,
      restrictedToSelf: true,
    };
  }

  return {
    kind: "notes",
    userId: options.userId ?? null,
    bucketStart: options.bucketStart ?? null,
    total,
    truncated,
    restrictedToSelf: restrictToSelf,
    rows: kept.map((row) => ({
      id: row.id,
      label: row.subject ?? "(no subject)",
      sublabel: row.body,
      attachedTo: row.target,
      occurredAt: toIso(row.occurred_at),
      href: null,
    })),
  };
}

function toIso(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : new Date(String(value)).toISOString();
}
