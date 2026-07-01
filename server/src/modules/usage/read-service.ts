// server/src/modules/usage/read-service.ts
import type { UsageDailyShape } from "./types.js";
import { computeUsageDaily } from "./aggregate.js";
import { fetchRawUsageForDay, type QueryClient } from "./raw-fetch.js";
import { RAW_RETENTION_DAYS } from "./constants.js";
import { businessWeekDates, BUSINESS_TIMEZONE } from "../../lib/period.js";

export interface Requester { role: string; userId: string; }

/** Server-enforced scoping: reps are forced to self; admin/director may target one rep or all (null). */
export function resolveRepScope(req: Requester, requestedRep: string | undefined): string[] | null {
  if (req.role === "rep") return [req.userId];
  if (requestedRep) return [requestedRep];
  return null; // all reps
}

/** The 7 dates (Sun..Sat) of the canonical business week containing `anchor`. Matches period.ts. */
export function weekDates(anchor: string): string[] {
  return businessWeekDates(anchor);
}

/** The live "today" caller: fetch raw rows + fold. */
export async function buildLiveDay(
  client: QueryClient, schema: string, userId: string, date: string,
): Promise<UsageDailyShape> {
  const raw = await fetchRawUsageForDay(client, schema, userId, date);
  return computeUsageDaily(raw);
}

/** Sum a set of daily shapes into one (used for weekly grain). */
export function sumDays(userId: string, label: string, days: UsageDailyShape[]): UsageDailyShape {
  const acc: UsageDailyShape = {
    userId, date: label, activeSeconds: 0, sessionCount: 0, viewCount: 0, actionCount: 0,
    breakdown: { deal_views: 0, lead_views: 0, report_views: 0, page_views: 0, creates: 0, edits: 0, stage_moves: 0, uploads: 0, activities: {} },
    firstActiveAt: null, lastActiveAt: null,
  };
  let hasTime = false;
  const activityAcc: Record<string, number> = {};
  for (const d of days) {
    acc.activeSeconds += d.activeSeconds;
    acc.sessionCount += d.sessionCount;
    acc.viewCount += d.viewCount;
    acc.actionCount += d.actionCount;
    acc.breakdown.deal_views += d.breakdown.deal_views;
    acc.breakdown.lead_views += d.breakdown.lead_views;
    acc.breakdown.report_views += d.breakdown.report_views;
    acc.breakdown.page_views += d.breakdown.page_views;
    acc.breakdown.creates += d.breakdown.creates;
    acc.breakdown.edits += d.breakdown.edits;
    acc.breakdown.stage_moves += d.breakdown.stage_moves;
    acc.breakdown.uploads += d.breakdown.uploads;
    for (const [k, v] of Object.entries(d.breakdown.activities)) {
      activityAcc[k] = (activityAcc[k] ?? 0) + v;
    }
    if (d.firstActiveAt) { hasTime = true; if (!acc.firstActiveAt || d.firstActiveAt < acc.firstActiveAt) acc.firstActiveAt = d.firstActiveAt; }
    if (d.lastActiveAt) { if (!acc.lastActiveAt || d.lastActiveAt > acc.lastActiveAt) acc.lastActiveAt = d.lastActiveAt; }
  }
  // Canonical (sorted) activity key order — byte-identical-friendly, matches computeUsageDaily.
  acc.breakdown.activities = Object.fromEntries(Object.keys(activityAcc).sort().map((k) => [k, activityAcc[k]]));
  // Leaderboard time-sort treats "no data" as absent: keep activeSeconds 0 but null timestamps.
  if (!hasTime) { acc.firstActiveAt = null; acc.lastActiveAt = null; }
  return acc;
}

const SCHEMA_RE = /^office_[a-z0-9_]+$/;
export interface RepRef { id: string; displayName: string; }

const ZERO_BREAKDOWN = () => ({
  deal_views: 0, lead_views: 0, report_views: 0, page_views: 0,
  creates: 0, edits: 0, stage_moves: 0, uploads: 0, activities: {} as Record<string, number>,
});

// The usage report surfaces everyone who works in the CRM web app — reps, directors, and admins — so a
// director/admin's own platform time shows up too (not just reps). Field contractors use the separate
// field app (T-Rock Cam) and don't emit these web heartbeats, so they stay excluded. Shared across both
// roster queries so the targeted and all-staff paths can't drift.
const USAGE_ROSTER_ROLE_SQL = `role IN ('rep', 'director', 'admin')`;

/** Resolve the staff roster for the request. scope=null → all active staff; else exactly those ids. */
export async function resolveReps(client: QueryClient, scope: string[] | null): Promise<RepRef[]> {
  if (scope) {
    if (scope.length === 0) return [];
    const placeholders = scope.map((_, i) => `$${i + 1}`).join(",");
    const { rows } = await client.query<{ id: string; display_name: string }>(
      `SELECT id, display_name FROM public.users WHERE id IN (${placeholders}) AND ${USAGE_ROSTER_ROLE_SQL} AND is_active = true AND COALESCE(is_test_data, false) = false`, scope,
    );
    return rows.map((r) => ({ id: r.id, displayName: r.display_name }));
  }
  const { rows } = await client.query<{ id: string; display_name: string }>(
    `SELECT id, display_name FROM public.users WHERE ${USAGE_ROSTER_ROLE_SQL} AND is_active = true AND COALESCE(is_test_data, false) = false ORDER BY display_name`,
  );
  return rows.map((r) => ({ id: r.id, displayName: r.display_name }));
}

/** Read one rolled-up day; returns a zeroed shape when no usage_daily row exists (pre-launch days). */
export async function readUsageDaily(client: QueryClient, schema: string, userId: string, date: string): Promise<UsageDailyShape> {
  if (!SCHEMA_RE.test(schema)) throw new Error(`invalid schema: ${schema}`);
  const { rows } = await client.query<{
    active_seconds: number; session_count: number; view_count: number; action_count: number;
    breakdown: UsageDailyShape["breakdown"]; first_active_at: Date | null; last_active_at: Date | null;
  }>(
    `SELECT active_seconds, session_count, view_count, action_count, breakdown, first_active_at, last_active_at
       FROM ${schema}.usage_daily WHERE user_id = $1 AND date = $2`,
    [userId, date],
  );
  const r = rows[0];
  if (!r) return { userId, date, activeSeconds: 0, sessionCount: 0, viewCount: 0, actionCount: 0, breakdown: ZERO_BREAKDOWN(), firstActiveAt: null, lastActiveAt: null };
  // Normalize breakdown key order to match computeUsageDaily's canonical insertion order.
  // Postgres JSONB may return keys in alphabetical/storage order; the byte-identical invariant
  // requires readUsageDaily to reconstruct them in the same sequence computeUsageDaily uses.
  const bd = r.breakdown;
  const normalizedBreakdown: UsageDailyShape["breakdown"] = {
    deal_views: Number(bd.deal_views),
    lead_views: Number(bd.lead_views),
    report_views: Number(bd.report_views),
    page_views: Number(bd.page_views),
    creates: Number(bd.creates),
    edits: Number(bd.edits),
    stage_moves: Number(bd.stage_moves),
    uploads: Number(bd.uploads),
    activities: Object.fromEntries(Object.keys(bd.activities ?? {}).sort().map((k) => [k, Number(bd.activities[k])])),
  };
  return {
    userId, date, activeSeconds: Number(r.active_seconds), sessionCount: Number(r.session_count),
    viewCount: Number(r.view_count), actionCount: Number(r.action_count),
    breakdown: normalizedBreakdown,
    firstActiveAt: r.first_active_at ? new Date(r.first_active_at).toISOString() : null,
    lastActiveAt: r.last_active_at ? new Date(r.last_active_at).toISOString() : null,
  };
}

/** Team summary strip. "active today" := activeSeconds > 0 (>=1 heartbeat) — applied consistently. */
export function buildTeamSummary(rows: { rep: RepRef; usage: UsageDailyShape }[]) {
  let activeSeconds = 0, actionCount = 0, activeReps = 0;
  for (const { usage } of rows) {
    activeSeconds += usage.activeSeconds;
    actionCount += usage.actionCount;
    if (usage.activeSeconds > 0) activeReps++;
  }
  return { activeSeconds, actionCount, activeReps, totalReps: rows.length };
}

/** Classify a report date relative to today (all YYYY-MM-DD; lexicographic == chronological). */
export function resolveDayKind(date: string, today: string): "past" | "live" | "future" {
  if (date < today) return "past";
  if (date > today) return "future";
  return "live";
}

/** A canonical zeroed day shape (no DB query) — used for future dates in the current week. */
export function emptyUsageDay(userId: string, date: string): UsageDailyShape {
  return { userId, date, activeSeconds: 0, sessionCount: 0, viewCount: 0, actionCount: 0, breakdown: ZERO_BREAKDOWN(), firstActiveAt: null, lastActiveAt: null };
}

/** Returns true when `date` falls within the raw-event retention window (0..RAW_RETENTION_DAYS-1 days old). */
export function isWithinDrilldownWindow(date: string, today: string): boolean {
  const ms = new Date(`${today}T00:00:00Z`).getTime() - new Date(`${date}T00:00:00Z`).getTime();
  const days = Math.floor(ms / 86_400_000);
  return days >= 0 && days < RAW_RETENTION_DAYS;
}

/**
 * The latest period date that is not in the future, for the views retention check. A current week's
 * range includes a future Saturday; `isWithinDrilldownWindow` treats future dates as out-of-window,
 * which would wrongly mark the current week's views "expired". Clamp to the newest non-future day
 * (today, for the current week) so only genuinely-old periods read as expired.
 */
export function latestNonFutureDate(dates: string[], today: string): string {
  const past = dates.filter((d) => d <= today);
  return past.length > 0 ? past[past.length - 1] : dates[0];
}

/**
 * The oldest date of the period that is still within the retention window — the lower bound for view
 * queries on a partially-pruned period, so lingering rows older than the window (if pruning lags) are
 * never surfaced past the retention gate. Falls back to the first date when none are in-window.
 */
export function oldestInWindowDate(dates: string[], today: string): string {
  return dates.find((d) => isWithinDrilldownWindow(d, today)) ?? dates[0];
}

/**
 * The view-detail retention state for a period, decided purely from its dates and `today`. Views are
 * raw events pruned at the retention window; actions are never pruned. Four states:
 *  - `future`    — the whole period is ahead of today (a future date-picker selection). No data yet,
 *                  NOT "expired" (which would be the opposite of the truth).
 *  - `expired`   — even the latest non-future day is older than the window; only counts survive.
 *  - `partial`   — the latest day is in-window but the period's earliest day is already pruned.
 *  - `available` — every day is in-window.
 * `queryFrom` is the clamped lower bound for the view query (the oldest in-window day for a partial
 * period, else the period start). Mirrors the /drilldown expired messaging.
 */
export type ViewsState =
  | { kind: "future" }
  | { kind: "expired" }
  | { kind: "partial"; queryFrom: string }
  | { kind: "available"; queryFrom: string };

export function classifyViewsState(dates: string[], today: string): ViewsState {
  const fromDate = dates[0];
  if (fromDate > today) return { kind: "future" };
  const latest = latestNonFutureDate(dates, today);
  if (!isWithinDrilldownWindow(latest, today)) return { kind: "expired" };
  const partial = !isWithinDrilldownWindow(fromDate, today);
  const queryFrom = partial ? oldestInWindowDate(dates, today) : fromDate;
  return partial ? { kind: "partial", queryFrom } : { kind: "available", queryFrom };
}

export interface ViewEventRow {
  at: string;
  entity_type: string;
  entity_id: string | null;
  route: string;
  label_snapshot: string | null;
}

/** Raw view events for one user+day, optionally filtered by entity_type, ordered chronologically. */
export async function readViewEvents(
  client: QueryClient,
  schema: string,
  userId: string,
  date: string,
  type?: string,
): Promise<ViewEventRow[]> {
  if (!SCHEMA_RE.test(schema)) throw new Error(`invalid schema: ${schema}`);
  const params: unknown[] = [userId, date];
  let typeClause = "";
  if (type) { params.push(type); typeClause = ` AND v.entity_type = $3`; }
  const { rows } = await client.query<ViewEventRow>(
    `SELECT v.at, v.entity_type, v.entity_id, v.route, v.label_snapshot
       FROM ${schema}.usage_view_event v
       JOIN ${schema}.usage_session s ON s.id = v.session_id AND s.user_id = v.user_id
      WHERE v.user_id = $1
        AND s.impersonator_id IS NULL
        AND v.at >= ($2::timestamp AT TIME ZONE '${BUSINESS_TIMEZONE}')
        AND v.at < (($2::date + 1)::timestamp AT TIME ZONE '${BUSINESS_TIMEZONE}')${typeClause}
      ORDER BY v.at`,
    params,
  );
  return rows;
}

/**
 * Raw view events for a user over the half-open business-tz range [fromDate, toExclusiveDate),
 * newest first. Reuses the same impersonation + ownership join as the single-day drilldown; used
 * by the rep-detail page so a week's views come back in one query.
 */
export async function readViewEventsRange(
  client: QueryClient,
  schema: string,
  userId: string,
  fromDate: string,
  toExclusiveDate: string,
): Promise<ViewEventRow[]> {
  if (!SCHEMA_RE.test(schema)) throw new Error(`invalid schema: ${schema}`);
  const { rows } = await client.query<ViewEventRow>(
    `SELECT v.at, v.entity_type, v.entity_id, v.route, v.label_snapshot
       FROM ${schema}.usage_view_event v
       JOIN ${schema}.usage_session s ON s.id = v.session_id AND s.user_id = v.user_id
      WHERE v.user_id = $1
        AND s.impersonator_id IS NULL
        AND v.at >= ($2::timestamp AT TIME ZONE '${BUSINESS_TIMEZONE}')
        AND v.at < ($3::timestamp AT TIME ZONE '${BUSINESS_TIMEZONE}')
      ORDER BY v.at DESC`,
    [userId, fromDate, toExclusiveDate],
  );
  return rows;
}

export type ActionDetailType = "create" | "edit" | "stage_move" | "upload" | "note";

export interface ActionDetailItem {
  type: ActionDetailType;
  label: string;
  entityType: string | null;
  at: string;
}

export interface ActionDetail {
  breakdown: Record<ActionDetailType, number>;
  items: ActionDetailItem[];
  truncated: boolean;
}

const ACTION_DETAIL_LIMIT = 500;

/** Classify an audit_log create/edit row (creates/edits only — stage/note/upload have their own
 *  sources). Pure — exported for testing. */
export function classifyAction(action: string, isStage: boolean): ActionDetailType {
  if (isStage) return "stage_move";
  return action === "insert" ? "create" : "edit";
}

/**
 * Compose a scannable stage-move label: the deal name plus the stage transition. `from_stage` is NULL
 * on an initial entry (so just the entered stage), and any of these can be NULL when the entity/stage
 * was deleted (graceful fallback, never a throw). Pure — exported for testing.
 */
export function composeStageLabel(dealName: string | null, fromStage: string | null, toStage: string | null): string {
  const move = fromStage && toStage ? `${fromStage} → ${toStage}` : (toStage ?? fromStage ?? null);
  if (dealName && move) return `${dealName}: ${move}`;
  return dealName ?? move ?? "Stage move";
}

// Detail actions mirror the AGGREGATE's action sources (raw-fetch.ts / USAGE_ACTION_SOURCES) so the
// breakdown reconciles with the leaderboard's action count — sourcing each bucket from the SAME table,
// crediting column, and timestamp the rollup uses:
//  - creates/edits  -> audit_log, table NOT IN (activities, files), EXCLUDING stage updates; credited
//                      by changed_by; impersonated writes excluded (impersonator_id IS NULL).
//  - stage_move     -> deal_stage_history (one row per change; changed_by). Sourcing from audit would
//                      double-count: a stage change writes BOTH a trigger row (changes.stage_id) and an
//                      explicit logActivity row (changes.stageId). No impersonator column (caveat).
//  - note           -> activities, credited by COALESCE(performed_by_user_id, responsible_user_id) and
//                      dated by COALESCE(occurred_at, created_at) — NOT the audit row. Sourcing from
//                      audit_log inserts would drop notes credited to a different user and misdate
//                      backdated activities (occurred_at), diverging from the counted breakdown.
//  - upload         -> files, credited by uploaded_by, dated by created_at — NOT the audit row.
const IS_STAGE_SQL =
  `(al.table_name = 'deals' AND al.changes IS NOT NULL AND (al.changes ? 'stage_id' OR al.changes ? 'stageId'))`;
const AUDIT_DETAIL_WHERE = `al.changed_by = $1
        AND al.impersonator_id IS NULL
        AND al.table_name NOT IN ('activities', 'files')
        AND NOT ${IS_STAGE_SQL}
        AND al.action IN ('insert', 'update')
        AND al.created_at >= ($2::timestamp AT TIME ZONE '${BUSINESS_TIMEZONE}')
        AND al.created_at < ($3::timestamp AT TIME ZONE '${BUSINESS_TIMEZONE}')`;
const STAGE_DETAIL_WHERE = `sh.changed_by = $1
        AND sh.created_at >= ($2::timestamp AT TIME ZONE '${BUSINESS_TIMEZONE}')
        AND sh.created_at < ($3::timestamp AT TIME ZONE '${BUSINESS_TIMEZONE}')`;
// Notes: activities table, aggregate crediting/dating (COALESCE on user and timestamp).
const NOTE_AT_SQL = `COALESCE(a.occurred_at, a.created_at)`;
const NOTE_DETAIL_WHERE = `COALESCE(a.performed_by_user_id, a.responsible_user_id) = $1
        AND ${NOTE_AT_SQL} >= ($2::timestamp AT TIME ZONE '${BUSINESS_TIMEZONE}')
        AND ${NOTE_AT_SQL} < ($3::timestamp AT TIME ZONE '${BUSINESS_TIMEZONE}')`;
const UPLOAD_DETAIL_WHERE = `f.uploaded_by = $1
        AND f.created_at >= ($2::timestamp AT TIME ZONE '${BUSINESS_TIMEZONE}')
        AND f.created_at < ($3::timestamp AT TIME ZONE '${BUSINESS_TIMEZONE}')`;

/**
 * Itemized actions for a user over [fromDate, toExclusiveDate) (business-tz), newest first, plus a
 * by-type breakdown. None of these sources are pruned, so this is always available regardless of
 * period age (unlike views). Each bucket is sourced exactly as the aggregate sources it: creates/edits
 * from audit_log, stage moves from deal_stage_history, notes from activities, uploads from files.
 */
export async function readActionDetail(
  client: QueryClient,
  schema: string,
  userId: string,
  fromDate: string,
  toExclusiveDate: string,
): Promise<ActionDetail> {
  if (!SCHEMA_RE.test(schema)) throw new Error(`invalid schema: ${schema}`);
  const params = [userId, fromDate, toExclusiveDate];
  const cnt = async (sql: string) => Number((await client.query<{ n: number }>(sql, params)).rows[0]?.n ?? 0);

  // Breakdown over the FULL period (never truncated) so the chips reconcile with the leaderboard.
  const auditCounts = (
    await client.query<{ c_create: number; c_edit: number }>(
      `SELECT
          count(*) FILTER (WHERE al.action = 'insert')::int AS c_create,
          count(*) FILTER (WHERE al.action = 'update')::int AS c_edit
         FROM ${schema}.audit_log al
        WHERE ${AUDIT_DETAIL_WHERE}`,
      params,
    )
  ).rows[0];
  const breakdown: Record<ActionDetailType, number> = {
    create: Number(auditCounts?.c_create ?? 0),
    edit: Number(auditCounts?.c_edit ?? 0),
    stage_move: await cnt(`SELECT count(*)::int AS n FROM ${schema}.deal_stage_history sh WHERE ${STAGE_DETAIL_WHERE}`),
    upload: await cnt(`SELECT count(*)::int AS n FROM ${schema}.files f WHERE ${UPLOAD_DETAIL_WHERE}`),
    note: await cnt(`SELECT count(*)::int AS n FROM ${schema}.activities a WHERE ${NOTE_DETAIL_WHERE}`),
  };

  // Itemized display: one query per source, merged newest-first, capped. (The chips above stay
  // full-period accurate even when the list is truncated.) Each source caps at LIMIT+1 so the merge
  // can detect truncation without an over-large fetch.
  const cap = ACTION_DETAIL_LIMIT + 1;
  // Per-entity label resolution: most create/edit rows carry NO entity_name_snapshot (tasks/emails/
  // contacts store null), so join each audited table by record_id and resolve its real name/title/
  // subject. Every join is a gated LEFT JOIN (table_name + record_id), so a deleted record simply
  // yields null and falls through to entity_type/table_name as a last resort — never a 500. All
  // label sources are text/varchar (no enum), so the COALESCE type-matches.
  const auditRows = (
    await client.query<{ action: string; table_name: string; created_at: string; label: string | null }>(
      `SELECT al.action, al.table_name, al.created_at,
              COALESCE(
                al.entity_name_snapshot,
                d.name, l.name, t.title,
                NULLIF(TRIM(CONCAT_WS(' ', co.first_name, co.last_name)), ''),
                em.subject,
                al.entity_type, al.table_name
              ) AS label
         FROM ${schema}.audit_log al
         LEFT JOIN ${schema}.deals d     ON al.table_name = 'deals'    AND al.record_id = d.id
         LEFT JOIN ${schema}.leads l     ON al.table_name = 'leads'    AND al.record_id = l.id
         LEFT JOIN ${schema}.tasks t     ON al.table_name = 'tasks'    AND al.record_id = t.id
         LEFT JOIN ${schema}.contacts co ON al.table_name = 'contacts' AND al.record_id = co.id
         LEFT JOIN ${schema}.emails em   ON al.table_name = 'emails'   AND al.record_id = em.id
        WHERE ${AUDIT_DETAIL_WHERE}
        ORDER BY al.created_at DESC
        LIMIT ${cap}`,
      params,
    )
  ).rows;
  // Stage moves: deal name + from → to stage names. Stage names live in public.pipeline_stage_config
  // (cross-schema, shared); from_stage_id is NULL on initial entry. LEFT JOINs keep it null-safe.
  const stageRows = (
    await client.query<{ created_at: string; deal_name: string | null; from_stage: string | null; to_stage: string | null }>(
      `SELECT sh.created_at, d.name AS deal_name, fs.name AS from_stage, ts.name AS to_stage
         FROM ${schema}.deal_stage_history sh
         LEFT JOIN ${schema}.deals d ON sh.deal_id = d.id
         LEFT JOIN public.pipeline_stage_config fs ON sh.from_stage_id = fs.id
         LEFT JOIN public.pipeline_stage_config ts ON sh.to_stage_id = ts.id
        WHERE ${STAGE_DETAIL_WHERE}
        ORDER BY sh.created_at DESC
        LIMIT ${cap}`,
      params,
    )
  ).rows;
  const noteRows = (
    await client.query<{ at: string; label: string | null; entity_type: string | null }>(
      `SELECT ${NOTE_AT_SQL} AS at,
              -- a.type is the activity_type ENUM; cast to text so COALESCE matches the varchar
              -- columns (subject/deal/lead names) — an un-cast enum throws "COALESCE types ...
              -- cannot be matched" against the real schema (PGlite text columns hid this).
              COALESCE(a.subject, d.name, l.name, a.type::text) AS label,
              CASE WHEN a.deal_id IS NOT NULL THEN 'deal' WHEN a.lead_id IS NOT NULL THEN 'lead' ELSE NULL END AS entity_type
         FROM ${schema}.activities a
         LEFT JOIN ${schema}.deals d ON a.deal_id = d.id
         LEFT JOIN ${schema}.leads l ON a.lead_id = l.id
        WHERE ${NOTE_DETAIL_WHERE}
        ORDER BY ${NOTE_AT_SQL} DESC
        LIMIT ${cap}`,
      params,
    )
  ).rows;
  const uploadRows = (
    await client.query<{ at: string; label: string | null; entity_type: string | null }>(
      `SELECT f.created_at AS at,
              COALESCE(f.display_name, f.original_filename) AS label,
              CASE WHEN f.deal_id IS NOT NULL THEN 'deal' WHEN f.lead_id IS NOT NULL THEN 'lead' ELSE NULL END AS entity_type
         FROM ${schema}.files f
        WHERE ${UPLOAD_DETAIL_WHERE}
        ORDER BY f.created_at DESC
        LIMIT ${cap}`,
      params,
    )
  ).rows;

  const merged: ActionDetailItem[] = [
    ...auditRows.map((r) => ({
      type: classifyAction(r.action, false),
      label: r.label ?? r.table_name,
      entityType: r.table_name,
      at: r.created_at,
    })),
    ...stageRows.map((r) => ({
      type: "stage_move" as ActionDetailType,
      label: composeStageLabel(r.deal_name, r.from_stage, r.to_stage),
      entityType: "deal" as string | null,
      at: r.created_at,
    })),
    ...noteRows.map((r) => ({
      type: "note" as ActionDetailType,
      label: r.label ?? "Activity",
      entityType: r.entity_type,
      at: r.at,
    })),
    ...uploadRows.map((r) => ({
      type: "upload" as ActionDetailType,
      label: r.label ?? "File",
      entityType: r.entity_type,
      at: r.at,
    })),
  ].sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
  const truncated = merged.length > ACTION_DETAIL_LIMIT;
  const items = merged.slice(0, ACTION_DETAIL_LIMIT);
  return { breakdown, items, truncated };
}
