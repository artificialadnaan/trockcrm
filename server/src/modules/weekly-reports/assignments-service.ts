// What ONE person owes, and what is waiting on their review — the T-Rock Cam hub's feed.
//
// Deliberately not `getWeeklyReportDashboard`. That function answers a leadership question: every active
// project in the office, generated from the cadence, with each client's contact block and every crew's
// misses. A superintendent must not be able to read it, which is why the CRM router is gated to
// admin/director/rep. This answers the phone's question instead — the two or three jobs THIS user is
// assigned to — so the same feature can be office-wide on one surface and personal on the other without
// either one being a filtered view of the wrong query.
//
// The cadence arithmetic itself is not re-implemented: `weeklyReportExpectedWeeks` is the same generator
// the dashboard and the reminder worker use, so a week the app offers is a week the board is looking for.

import {
  weeklyReportDaysLate,
  weeklyReportExpectedWeeks,
  type WeeklyReportPauseInterval,
  weeklyReportWeekOf,
  type WeeklyReportStatus,
  type WeeklyReportWeekState,
} from "@trock-crm/shared/types";
import type { QueryExecutor } from "./projects-service.js";

/** Roles that see every project rather than only their own assignments (matches ELEVATED_ROLES). */
const ELEVATED_ROLES = new Set(["admin", "director"]);

/**
 * How many outstanding earlier weeks the app offers per project.
 *
 * The phone is not the backlog-management surface — that is the CRM board, which counts everything. Five
 * is enough to make "you missed some" actionable without turning a project card into a wall of guilt.
 */
export const APP_OUTSTANDING_WEEK_LIMIT = 5;

/**
 * How many review rows one payload carries.
 *
 * Unlike the backlog limit above this is a TRANSPORT cap rather than a product decision — every row in
 * this queue is somebody's actual move — so it is always reported alongside `pendingReviewTotal`. A silent
 * cap here is worse than it looks: approving does NOT clear a row (an approved-but-unsent report stays,
 * deliberately), so a queue that only drains when a report is sent would have hidden everything past the
 * limit for as long as the backlog stood.
 */
export const APP_REVIEW_QUEUE_LIMIT = 100;

/** The last filed week before a given week, and the cumulative figures it carried. */
export interface WeeklyReportPredecessor {
  weekOf: string;
  completionPercent: number | null;
  weatherDelayDays: number | null;
}

export interface WeeklyReportAssignment {
  weeklyReportProjectId: string;
  dealId: string;
  projectName: string;
  projectNumber: string | null;
  clientName: string | null;
  /** The acting user's relationship to this project. Both are true on a one-person job. */
  isSuper: boolean;
  isPm: boolean;
  cadenceWeekday: number;
  /** The cadence week currently in flight — what `week_of` auto-fills to. */
  currentWeekOf: string;
  currentState: WeeklyReportWeekState;
  currentReportId: string | null;
  /**
   * The newest week this project has SENT, and its report id — null until one has gone out.
   *
   * Separate from `currentReportId`, which only ever describes `currentWeekOf`. This is what survives a
   * cadence rollover, and it is the handle the app needs to offer a delivered report's client link again.
   */
  lastSentReportId: string | null;
  lastSentWeekOf: string | null;
  currentReportStatus: WeeklyReportStatus | null;
  /**
   * False once reporting has ENDED but missed weeks remain: `currentWeekOf` is then past
   * `cadence_end_date` and `assertValidWeekOf` refuses it, so the card must not offer to start it.
   */
  currentWeekFilable: boolean;
  /**
   * How late the OLDEST week still owed is. 0 when only the current, not-yet-due week is outstanding.
   *
   * Measured over the WHOLE backlog, not over the truncated `outstandingWeeks` list — see the comment at
   * the assignment below. A project 32 weeks behind must not report the lateness of a project 5 behind.
   */
  daysLate: number;
  /**
   * Earlier weeks still owed, oldest first. Offered rather than auto-selected: a super opening the app on
   * Thursday is almost always writing THIS week, and silently retargeting them at a week from a month ago
   * would file the wrong report under the wrong date.
   *
   * "Still owed" means nothing was FILED — a week whose only report is a `draft` is still owed, and stays
   * here carrying its id in `outstandingWeekReportIds`. Dropping it the moment a row existed made a week
   * unreachable from the phone forever: the wizard creates the row on the photos step, so a super who
   * walked that far and then discarded the local draft (or reinstalled, or changed phone) lost the week
   * off the hub while the CRM board still showed it as "With super".
   */
  outstandingWeeks: string[];
  /**
   * The existing report id for an outstanding week, when one exists. Absent for a week that was never
   * started. The app passes it to the wizard so a resumed week reopens ITS row rather than posting a
   * second create for the same week.
   */
  outstandingWeekReportIds: Record<string, string>;
  /** True when the backlog was truncated, so the app can say so instead of implying it is complete. */
  hasMoreOutstandingWeeks: boolean;
  /** Last filed week's numbers, so step 5 is a nudge rather than re-entry. */
  previousWeekOf: string | null;
  previousCompletionPercent: number | null;
  previousWeatherDelayDays: number | null;
  /** Predecessor figures keyed by the week being filled. Cumulative values must not cross weeks. */
  previousByWeekOf: Record<string, WeeklyReportPredecessor>;
}

export interface WeeklyReportReviewItem {
  reportId: string;
  weeklyReportProjectId: string;
  dealId: string;
  projectName: string;
  weekOf: string;
  status: WeeklyReportStatus;
  authoredByName: string | null;
  submittedAt: string | null;
}

/**
 * A week the PM SENT that the mail provider has not accepted — the state nothing on this surface used to
 * mention at all.
 *
 * Carries FACTS, not a verdict. `sendError` / `sendAttempts` / `sendLastAttemptAt` / `sentAt` are the four
 * columns the CRM board derives "Send failed", "Send stuck" and "Sending…" from, and they travel raw so the
 * phone can draw the same three-way distinction from the same evidence. Deriving the verdict here instead
 * would have to be recomputed on every poll to stay true — the stall case is a CLOCK reading, not a stored
 * fact — and would have left the app unable to say anything at all about a payload it had cached for ten
 * minutes.
 *
 * `sentAt` is here for a second reason beyond display: it is the age the mail provider's idempotency window
 * is measured against, so it is what tells the app whether a Retry needs the duplicate-risk acknowledgement
 * the send service refuses to proceed without.
 *
 * There is deliberately no `sendDeliveredAt`: the query's own predicate is `send_delivered_at IS NULL`, so
 * the field could only ever be null here, and a structurally-null field is an invitation to key a branch on
 * something that can never change.
 */
export interface WeeklyReportUndeliveredSend {
  reportId: string;
  weeklyReportProjectId: string;
  dealId: string;
  projectName: string;
  weekOf: string;
  /** Shown alongside the week, because a v2 that has not landed reads very differently from a v1. */
  version: number;
  /** When the PM committed the send. Stamped once and never moved — see `sendLastAttemptAt`. */
  sentAt: string | null;
  sendError: string | null;
  sendAttempts: number;
  /** When the delivery was last ATTEMPTED — written by the worker, and by a retry when it re-queues. */
  sendLastAttemptAt: string | null;
}

export interface WeeklyReportAssignments {
  asOf: string;
  projects: WeeklyReportAssignment[];
  /** Reports sitting in this PM's queue, newest first. Empty for a user who is nobody's PM. */
  pendingReview: WeeklyReportReviewItem[];
  /**
   * How many rows the queue actually holds. Greater than `pendingReview.length` ⇒ the payload was capped
   * at `APP_REVIEW_QUEUE_LIMIT` and the app must say so rather than present a truncated list as the whole
   * of somebody's workload.
   */
  pendingReviewTotal: number;
  /**
   * Weeks this PM sent that have not reached the client. Newest first, capped, counted.
   *
   * A SEPARATE LIST RATHER THAN A WIDER `pendingReview` PREDICATE, which is the obvious move and is wrong
   * here twice over. See `listUndeliveredWeeklyReportSends`.
   */
  undeliveredSends: WeeklyReportUndeliveredSend[];
  /** The true depth of the list above, which the payload caps — same contract as `pendingReviewTotal`. */
  undeliveredSendsTotal: number;
}

function toIsoDate(value: unknown): string | null {
  if (value == null) return null;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === "string") return value.slice(0, 10);
  return null;
}

function toIsoTimestamp(value: unknown): string | null {
  if (value == null) return null;
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

// numeric(5,2) arrives from node-postgres as a STRING; the app's prefill wants a number it can render.
function toNumberOrNull(value: unknown): number | null {
  if (value == null) return null;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

const REPORT_STATE_BY_STATUS: Record<string, WeeklyReportWeekState> = {
  draft: "draft",
  pending_review: "pending_review",
  approved: "approved",
  sent: "sent",
};

export async function listWeeklyReportAssignments(
  client: QueryExecutor,
  input: { userId: string; role: string; asOf: string },
): Promise<WeeklyReportAssignments> {
  const elevated = ELEVATED_ROLES.has(input.role);

  // An elevated user sees every active project because the services already let them act on every one;
  // showing them a filtered list would hide work they are authorised to unblock. Everyone else sees the
  // projects they are named on — the SAME two columns `canEditWeeklyReport`/`canTransitionAs` read, so
  // the hub can never offer a card whose wizard then 403s.
  const projectsResult = await client.query(
    `SELECT wrp.id, wrp.deal_id, wrp.property_display_name, wrp.client_name,
            wrp.cadence_weekday, wrp.cadence_start_date, wrp.cadence_end_date,
            wrp.trock_pm_user_id, wrp.trock_super_user_id,
            d.name AS deal_name, d.project_number
       FROM weekly_report_projects wrp
       JOIN deals d ON d.id = wrp.deal_id
      WHERE wrp.is_active
        AND wrp.status = 'active'
        AND ($2::boolean
             OR wrp.trock_super_user_id = $1::uuid
             OR wrp.trock_pm_user_id = $1::uuid)
      ORDER BY COALESCE(wrp.property_display_name, d.name) ASC`,
    [input.userId, elevated],
  );
  if (projectsResult.rows.length === 0) {
    // Still ask for BOTH lists. The projects query is scoped to `status = 'active'` and neither list is —
    // a PM whose only project has since been paused or completed can still be holding a submitted report
    // on it, and can still have sent a client an email that never arrived. Pausing a job stops the cadence
    // generating weeks; it does not un-send an email, and returning empty lists here would hide both with
    // nobody responsible for them.
    const queue = await listWeeklyReportsAwaitingReview(client, input);
    const undelivered = await listUndeliveredWeeklyReportSends(client, input);
    return {
      asOf: input.asOf,
      projects: [],
      pendingReview: queue.items,
      pendingReviewTotal: queue.total,
      undeliveredSends: undelivered.items,
      undeliveredSendsTotal: undelivered.total,
    };
  }

  const projectIds = projectsResult.rows.map((row) => row.id);

  // Only the LIVE version of each week. A superseded report keeps its row for history but must not decide
  // the week's state — the correction that replaced it does.
  const reportsResult = await client.query(
    `SELECT DISTINCT ON (weekly_report_project_id, week_of)
            id, weekly_report_project_id, week_of, status, completion_percent, weather_delay_days
       FROM weekly_reports
      WHERE weekly_report_project_id = ANY($1::uuid[])
        AND is_active
        AND superseded_by_id IS NULL
      ORDER BY weekly_report_project_id, week_of, version DESC`,
    [projectIds],
  );
  const dismissalsResult = await client.query(
    `SELECT weekly_report_project_id, week_of
       FROM weekly_report_dismissals
      WHERE weekly_report_project_id = ANY($1::uuid[])`,
    [projectIds],
  );

  const reportByKey = new Map<string, Record<string, any>>();
  for (const row of reportsResult.rows) {
    reportByKey.set(`${row.weekly_report_project_id}|${toIsoDate(row.week_of)}`, row);
  }
  const dismissedKeys = new Set<string>();
  for (const row of dismissalsResult.rows) {
    dismissedKeys.add(`${row.weekly_report_project_id}|${toIsoDate(row.week_of)}`);
  }

  // The pause ledger, exactly as dashboard-service loads it. Without it the hub and the CRM board
  // disagree about which weeks are owed: a project paused for six weeks comes back showing six
  // outstanding cards, reports false lateness against them, and lets a superintendent file CLIENT
  // reports for weeks the project never owed.
  const pausesResult = await client.query(
    `SELECT weekly_report_project_id, paused_from, resumed_on
       FROM weekly_report_pauses
      WHERE weekly_report_project_id = ANY($1::uuid[])
      ORDER BY weekly_report_project_id, paused_from`,
    [projectIds],
  );
  const pausesByProject = new Map<string, WeeklyReportPauseInterval[]>();
  for (const row of pausesResult.rows) {
    const intervals = pausesByProject.get(row.weekly_report_project_id) ?? [];
    intervals.push({ from: toIsoDate(row.paused_from)!, to: toIsoDate(row.resumed_on) });
    pausesByProject.set(row.weekly_report_project_id, intervals);
  }

  const projects: WeeklyReportAssignment[] = [];
  for (const project of projectsResult.rows) {
    const cadenceWeekday = Number(project.cadence_weekday);
    const currentWeekOf = weeklyReportWeekOf(cadenceWeekday, input.asOf);
    const expected = weeklyReportExpectedWeeks({
      cadenceWeekday,
      cadenceStartDate: toIsoDate(project.cadence_start_date)!,
      cadenceEndDate: toIsoDate(project.cadence_end_date),
      throughDate: currentWeekOf,
      pausedIntervals: pausesByProject.get(project.id) ?? null,
    });
    // A project whose cadence has not started yet owes nothing at all. It stays off the hub rather than
    // showing a card whose only action would be rejected by assertValidWeekOf.
    if (expected.length === 0) continue;

    // Reporting can have ENDED while weeks are still outstanding — `weeklyReportExpectedWeeks` clamps to
    // the end date and still returns the historical weeks, so `expected` is non-empty. Those missed weeks
    // must stay fileable, but `currentWeekOf` is past the end date and `assertValidWeekOf` refuses it, so
    // the card must not offer it. Without this the button is a guaranteed 400.
    const cadenceEndDate = toIsoDate(project.cadence_end_date);
    const currentWeekFilable = !cadenceEndDate || currentWeekOf <= cadenceEndDate;

    const currentKey = `${project.id}|${currentWeekOf}`;
    const currentReport = reportByKey.get(currentKey);
    const currentState: WeeklyReportWeekState = currentReport
      ? REPORT_STATE_BY_STATUS[currentReport.status] ?? "not_started"
      : dismissedKeys.has(currentKey)
        ? "dismissed"
        : "not_started";

    // Walk BACKWARDS from the most recent so the truncation drops the oldest weeks, not the newest —
    // reversed at the end to keep the app's list chronological.
    //
    // The walk does NOT stop at the limit, it only stops COLLECTING. `daysLate` has to answer "how late is
    // the oldest week still owed", and breaking out left it answering "how late is the oldest of the five
    // newest" — so a project 32 weeks behind reported 35 days late, understating lateness exactly on the
    // projects neglected longest. Scanning the rest of an already-materialised array is free.
    const outstanding: string[] = [];
    const outstandingReportIds: Record<string, string> = {};
    let olderStillOutstanding = false;
    let oldestOutstanding: string | null = null;
    for (let i = expected.length - 1; i >= 0; i -= 1) {
      const weekOf = expected[i]!;
      if (weekOf === currentWeekOf) continue;
      const key = `${project.id}|${weekOf}`;
      // A DRAFT is not a filing — the client has seen nothing — so the week stays owed and stays offered,
      // carrying its report id. Anything past draft is with the PM or done, and is not the super's move.
      const existing = reportByKey.get(key);
      if (dismissedKeys.has(key) || (existing && existing.status !== "draft")) continue;
      oldestOutstanding = weekOf;
      if (outstanding.length >= APP_OUTSTANDING_WEEK_LIMIT) {
        olderStillOutstanding = true;
        continue;
      }
      outstanding.push(weekOf);
      if (existing) outstandingReportIds[weekOf] = existing.id;
    }
    outstanding.reverse();

    /**
     * The most recent filed week strictly BEFORE `target`, whatever its status — a draft the super
     * started still carries the numbers they typed, and prefilling from it beats prefilling from
     * nothing.
     *
     * Resolved PER TARGET WEEK, not once. Completion % and weather delays are CUMULATIVE, so a single
     * predecessor shared across every outstanding week seeded a missed July report with August's
     * figures once August had been filed — overstating July's progress and its delay total on a
     * document that goes to the client as a record of that week.
     */
    const predecessorFor = (target: string) => {
      for (let i = expected.length - 1; i >= 0; i -= 1) {
        const weekOf = expected[i]!;
        if (weekOf >= target) continue;
        const found = reportByKey.get(`${project.id}|${weekOf}`);
        if (found) {
          return {
            weekOf,
            completionPercent: toNumberOrNull(found.completion_percent),
            weatherDelayDays: (found.weather_delay_days ?? null) as number | null,
          };
        }
      }
      return null;
    };

    // One entry per week this hub can actually open: the current week plus every outstanding one.
    const previousByWeekOf: Record<string, WeeklyReportPredecessor> = {};
    for (const target of [currentWeekOf, ...outstanding]) {
      const found = predecessorFor(target);
      if (found) previousByWeekOf[target] = found;
    }
    const previousForCurrent = previousByWeekOf[currentWeekOf] ?? null;

    // THE MOST RECENT WEEK THIS PROJECT ACTUALLY SENT, which is not the same thing as the current one and
    // is the only durable handle the phone has on a delivered report.
    //
    // `currentReportId` is defined for `currentWeekOf` alone. The moment the cadence rolls over, a report
    // the client DID receive is neither the current week nor in `undeliveredSends` (that query carries
    // `send_delivered_at IS NULL`), so every route the app had to it disappears — and "the client lost the
    // email" is a thing that happens weeks later, not during the week it was sent.
    //
    // Bounded by `expected`, i.e. the same lookback the rest of this payload uses. A send older than that
    // window is not reachable from the phone and remains a CRM job; that is a deliberate limit rather than
    // an oversight, and it keeps this a derivation over rows already in memory instead of a second query.
    const lastSent = (() => {
      for (let i = expected.length - 1; i >= 0; i -= 1) {
        const found = reportByKey.get(`${project.id}|${expected[i]!}`);
        if (found && String(found.status) === "sent") return { row: found, weekOf: expected[i]! };
      }
      return null;
    })();

    projects.push({
      weeklyReportProjectId: project.id,
      dealId: project.deal_id,
      projectName: project.property_display_name ?? project.deal_name ?? "Untitled project",
      projectNumber: project.project_number ?? null,
      clientName: project.client_name ?? null,
      isSuper: project.trock_super_user_id === input.userId,
      isPm: project.trock_pm_user_id === input.userId,
      cadenceWeekday,
      currentWeekOf,
      currentState,
      currentReportId: currentReport?.id ?? null,
      lastSentReportId: (lastSent?.row.id as string | undefined) ?? null,
      lastSentWeekOf: lastSent?.weekOf ?? null,
      currentReportStatus: (currentReport?.status as WeeklyReportStatus) ?? null,
      currentWeekFilable,
      // Measured from the OLDEST week still owed, not from the current one — and not from the oldest
      // week the payload happens to CARRY.
      //
      // `weeklyReportWeekOf` returns the first cadence day ON OR AFTER `asOf`, so `currentWeekOf` is
      // never in the past and `weeklyReportDaysLate(currentWeekOf, asOf)` is structurally always 0 — the
      // late signal would be dead in every case, and the app's "N days late" line and its red chip would
      // be unreachable code. The moment a due date passes, that week leaves `currentWeekOf` and becomes
      // an OUTSTANDING week, which is exactly where the lateness now comes from. `oldestOutstanding` is
      // the whole backlog's oldest, which is why the walk above scans past APP_OUTSTANDING_WEEK_LIMIT.
      daysLate: oldestOutstanding ? weeklyReportDaysLate(oldestOutstanding, input.asOf) : 0,
      outstandingWeeks: outstanding,
      outstandingWeekReportIds: outstandingReportIds,
      hasMoreOutstandingWeeks: olderStillOutstanding,
      // Kept for the current week, which is what the primary card fills.
      previousWeekOf: previousForCurrent?.weekOf ?? null,
      previousCompletionPercent: previousForCurrent?.completionPercent ?? null,
      previousWeatherDelayDays: previousForCurrent?.weatherDelayDays ?? null,
      previousByWeekOf,
    });
  }

  const queue = await listWeeklyReportsAwaitingReview(client, input);
  const undelivered = await listUndeliveredWeeklyReportSends(client, input);
  return {
    asOf: input.asOf,
    projects,
    pendingReview: queue.items,
    pendingReviewTotal: queue.total,
    undeliveredSends: undelivered.items,
    undeliveredSendsTotal: undelivered.total,
  };
}

/**
 * The PM's queue: reports somebody has submitted, on projects this user is the PM for.
 *
 * `approved` is included alongside `pending_review` because an approved-but-unsent report is still the
 * PM's move: the send is the step after it, and it is now on this surface too (field-routes.ts), so a row
 * sitting here approved is work the person reading it can actually finish. Leaving it off would make an
 * approval look like the end of the line.
 *
 * `sent` IS NOT AND MUST NOT BE ADDED HERE. A week whose send failed is still the PM's move, but it is a
 * different move with different controls, and adding the status to this list would also bring every
 * successfully delivered week back into "waiting on your review" for ever. It travels as its own list —
 * see `listUndeliveredWeeklyReportSends`, which explains why a separate key rather than a wider predicate.
 *
 * NEWEST FIRST, and counted.
 *
 * Oldest-first is the intuitive order for a work queue, and it was wrong here for one reason: an approved
 * row does not leave this queue, only a SENT one does. Combined with the cap that meant the oldest hundred
 * held the list permanently — a report submitted this morning was invisible to its PM until somebody
 * cleared an unrelated backlog through the CRM, and nothing on the phone said so. Ordering by the most
 * recent week keeps the work that is actually in flight on screen and pushes the stale tail out of the
 * window instead, and `total` lets the caller name what it is not showing.
 */
async function listWeeklyReportsAwaitingReview(
  client: QueryExecutor,
  input: { userId: string; role: string },
): Promise<{ items: WeeklyReportReviewItem[]; total: number }> {
  const elevated = ELEVATED_ROLES.has(input.role);
  const result = await client.query(
    `SELECT wr.id, wr.weekly_report_project_id, wr.deal_id, wr.week_of, wr.status, wr.submitted_at,
            wrp.property_display_name, d.name AS deal_name,
            u.display_name AS authored_by_name,
            -- Counted over the WHOLE matching set: a window function is evaluated before LIMIT, so this
            -- is the true queue depth on every returned row and costs no second round trip.
            COUNT(*) OVER () AS total_count
       FROM weekly_reports wr
       JOIN weekly_report_projects wrp ON wrp.id = wr.weekly_report_project_id
       JOIN deals d ON d.id = wrp.deal_id
       LEFT JOIN public.users u ON u.id = wr.authored_by
      WHERE wr.is_active
        AND wr.superseded_by_id IS NULL
        AND wr.status IN ('pending_review', 'approved')
        AND wrp.is_active
        AND ($2::boolean OR wrp.trock_pm_user_id = $1::uuid)
      -- id last so the page is stable across refetches when two projects share a week.
      ORDER BY wr.week_of DESC, wr.submitted_at DESC NULLS LAST, wr.id
      LIMIT ${APP_REVIEW_QUEUE_LIMIT}`,
    [input.userId, elevated],
  );

  const total = Number(result.rows[0]?.total_count ?? 0);
  const items = result.rows.map((row) => ({
    reportId: row.id,
    weeklyReportProjectId: row.weekly_report_project_id,
    dealId: row.deal_id,
    projectName: row.property_display_name ?? row.deal_name ?? "Untitled project",
    weekOf: toIsoDate(row.week_of)!,
    status: row.status as WeeklyReportStatus,
    authoredByName: row.authored_by_name ?? null,
    submittedAt: toIsoTimestamp(row.submitted_at),
  }));
  return { items, total };
}

/**
 * The PM's sends that never reached the client — the half of their own work the app could not show them.
 *
 * A PM presses Send, the provider refuses the client's address, the worker stamps `send_error`, and from
 * T-Rock Cam that week simply ends: it leaves the review queue (which selects `pending_review`/`approved`)
 * and its project card reads "Sent". The only surfaces that ever said otherwise are the CRM board and the
 * sweep's alert email, and the ordinary `construction` PM can reach neither. This list is what makes the
 * failure visible to the one person who pressed the button.
 *
 * WHY NOT SIMPLY WIDEN THE REVIEW QUEUE'S `status IN (...)`. That is the obvious change and it is wrong for
 * two independent reasons.
 *
 *   1. `mobile/` HAS NO OTA. A server change reaches every phone already carrying the old binary, at once
 *      and with no way to follow it. Widening `pendingReview` would push `sent` rows into a list that build
 *      renders under "Waiting on your review" and whose only tap opens the review wizard — which reads the
 *      report, finds `canEdit: false` at `sent`, and dead-ends in a refusal dialog. A separate key is
 *      ignored outright by an older build, which is exactly the additive shape `pendingReviewTotal` and
 *      `outstandingWeekReportIds` already use here for the same reason.
 *   2. They are different work needing different controls. "Somebody wrote this, read it" ends in Approve;
 *      "the client never got this" ends in Retry or a correction. Merging them would put one list in front
 *      of the PM whose rows disagree about what the button under them does.
 *
 * AND IT EMPTIES ITSELF, which is the property that makes this safe to leave on the hub. The predicate is
 * `send_delivered_at IS NULL` — the stamp the worker writes when the provider accepts the message — so an
 * ordinary week appears for the seconds its delivery is in flight and is gone on the next refresh. Keying
 * on `send_error IS NOT NULL` instead would have been tighter and would have missed the worse case: a
 * delivery job that dead-letters having written nothing at all leaves NO error, and that row is a client
 * owed a report with nobody looking for it (see WEEKLY_REPORT_SEND_STALL_MINUTES in dashboard-service.ts).
 *
 * `superseded_by_id IS NULL` is the same predicate the board's undelivered query and the CRM's Retry button
 * carry, and it is load-bearing rather than tidy: a v1 whose delivery failed and which a delivered v2 has
 * since replaced is still `sent`, still undelivered, and still holds a live share URL in its stored
 * request. `retryWeeklyReportSend` refuses that row outright, so listing it would be an invitation to press
 * a button that cannot work — and if it ever did work it would email a client the version they were already
 * told was replaced.
 *
 * Scoped, capped and ordered exactly like the review queue above: the PM's own projects unless elevated,
 * newest week first, `APP_REVIEW_QUEUE_LIMIT` rows, and the true total alongside so the app can say what it
 * is not showing rather than present a truncated list as the whole of somebody's problem.
 *
 * No migration is needed for it: `weekly_reports_send_undelivered_idx` (0226) is partial on exactly
 * `is_active AND status = 'sent' AND send_delivered_at IS NULL`, which is this query's leading predicate.
 */
async function listUndeliveredWeeklyReportSends(
  client: QueryExecutor,
  input: { userId: string; role: string },
): Promise<{ items: WeeklyReportUndeliveredSend[]; total: number }> {
  const elevated = ELEVATED_ROLES.has(input.role);
  const result = await client.query(
    `SELECT wr.id, wr.weekly_report_project_id, wr.deal_id, wr.week_of, wr.version,
            wr.sent_at, wr.send_error, wr.send_attempts, wr.send_last_attempt_at,
            wrp.property_display_name, d.name AS deal_name,
            COUNT(*) OVER () AS total_count
       FROM weekly_reports wr
       JOIN weekly_report_projects wrp ON wrp.id = wr.weekly_report_project_id
       JOIN deals d ON d.id = wrp.deal_id
      WHERE wr.is_active
        AND wr.status = 'sent'
        AND wr.send_delivered_at IS NULL
        AND wr.superseded_by_id IS NULL
        AND wrp.is_active
        AND ($2::boolean OR wrp.trock_pm_user_id = $1::uuid)
      ORDER BY wr.week_of DESC, wr.sent_at DESC NULLS LAST, wr.id
      LIMIT ${APP_REVIEW_QUEUE_LIMIT}`,
    [input.userId, elevated],
  );

  const total = Number(result.rows[0]?.total_count ?? 0);
  const items = result.rows.map((row) => ({
    reportId: row.id,
    weeklyReportProjectId: row.weekly_report_project_id,
    dealId: row.deal_id,
    projectName: row.property_display_name ?? row.deal_name ?? "Untitled project",
    weekOf: toIsoDate(row.week_of)!,
    version: Number(row.version ?? 1),
    sentAt: toIsoTimestamp(row.sent_at),
    sendError: row.send_error ?? null,
    sendAttempts: Number(row.send_attempts ?? 0),
    sendLastAttemptAt: toIsoTimestamp(row.send_last_attempt_at),
  }));
  return { items, total };
}
