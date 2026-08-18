import {
  shiftIsoDate,
  weeklyReportDaysLate,
  weeklyReportExpectedWeeks,
  weeklyReportWeekOf,
  type WeeklyReportPauseInterval,
  type WeeklyReportWeekState,
} from "@trock-crm/shared/types";
import { AppError } from "../../middleware/error-handler.js";
import type { QueryExecutor } from "./projects-service.js";

/**
 * How many weeks of OUTSTANDING history the dashboard renders by default.
 *
 * A project set up a year ago with nothing filed would otherwise generate 52 rows of guilt, and the page
 * would spend its whole viewport on ancient history instead of this week. Anything older than the window
 * is COUNTED rather than dropped — `olderOutstandingCount` on each row group — so the page can say "and
 * 9 older" instead of silently pretending they do not exist.
 *
 * THE WINDOW BINDS UNDELIVERED SENDS TOO, and is measured the same way for both of the board's passes.
 * The cadence pass counts back `lookbackWeeks` ENTRIES through the generated week list; the undelivered
 * pass has no generated list to count through — that is the whole reason it exists — so it counts back
 * the same number of CALENDAR weeks from the week the project's cadence is on today. The two agree
 * exactly whenever no pause intervenes, and where a pause makes the cadence window reach further back the
 * undelivered pass is the more conservative of the two; it never renders a week the cadence pass would
 * have tallied instead. Either way the week is counted, never dropped: an undelivered send is the one
 * thing on this page nothing else would ever mention, so exempting it from the window was tempting, and
 * would have meant two passes disagreeing about where "recent" ends on the same board.
 */
export const DEFAULT_OUTSTANDING_LOOKBACK_WEEKS = 26;

/**
 * How long a `sent` report may sit undelivered before the board stops calling it "in flight".
 *
 * THE FAILURE THIS EXISTS FOR HAS NO ERROR MESSAGE. Every other signal on this page is a string somebody
 * wrote to the database; this one is the case where nothing was written at all. The delivery job's outcome
 * — `send_attempts`, `send_error`, `send_delivered_at` — is recorded in THE SAME DATABASE whose
 * unavailability is the likeliest reason the delivery failed in the first place, and the queue gives up
 * after three attempts with 3s/9s/27s backoff. A fault lasting a couple of minutes therefore dead-letters
 * the job having written nothing, leaving a row that reads `status = 'sent'`, `sent_at` set, `send_error`
 * NULL, `send_delivered_at` NULL, `send_attempts` 0 — indistinguishable, to a predicate keyed on the error
 * text, from a send queued five seconds ago. The client never receives their report and no surface says so.
 *
 * Time is the only evidence left, so time is what this uses. Generous enough that an ordinary queue backlog
 * does not cry wolf, short enough that a lost report is caught the same working day.
 */
export const WEEKLY_REPORT_SEND_STALL_MINUTES = 30;

export interface WeeklyReportDashboardRow {
  weeklyReportProjectId: string;
  dealId: string;
  projectName: string;
  projectNumber: string | null;
  clientName: string | null;
  trockPmUserId: string | null;
  trockPmName: string | null;
  trockSuperUserId: string | null;
  trockSuperName: string | null;
  weekOf: string;
  /** True for the cadence week currently in flight; false for an outstanding earlier week. */
  isCurrentWeek: boolean;
  state: WeeklyReportWeekState;
  daysLate: number;
  reportId: string | null;
  reportVersion: number | null;
  sentAt: string | null;
  sendError: string | null;
  /**
   * When the mail provider ACCEPTED the message. Null on a `sent` week means it has not got that far.
   *
   * Not proof a human received anything: there is no bounce webhook in this codebase, so a report
   * addressed to a mistyped domain is accepted, hard-bounces, and reads here exactly like one that landed.
   */
  sendDeliveredAt: string | null;
  sendAttempts: number;
  /**
   * A send this week is undelivered and the last attempt REPORTED AN ERROR.
   *
   * Derived on the server so the CRM and the app cannot disagree about what "Send failed" means — the two
   * facts it combines (an error, and no delivery) are individually misleading: an error left over from a
   * failed attempt that a retry then won is not a failure, and a null delivery on a send queued thirty
   * seconds ago is not one either.
   */
  sendFailed: boolean;
  /**
   * A send this week is undelivered, has recorded NO error, and is too old to still be in flight.
   *
   * The silent counterpart of `sendFailed`, and the more dangerous of the two: see
   * WEEKLY_REPORT_SEND_STALL_MINUTES. A row can only be `sent` because a PM pressed Send, so an undelivered
   * one that nothing has spoken for in half an hour is a client owed a report, whatever the row says.
   */
  sendStalled: boolean;
  /** A send this week is undelivered and still plausibly in flight — "Sending…", not a problem. */
  sendPending: boolean;
  /**
   * Which report id a Retry has to address.
   *
   * NOT necessarily `reportId`. A PM looking at a failed send reaches for the most prominent button on the
   * row, which is "Send correction", and that clone becomes the week's LIVE version while the failed
   * original — still `sent`, still undelivered, still un-superseded, because superseding happens at send —
   * keeps the actual problem. Pointing Retry at the live row would retry a report that was never sent.
   */
  sendRetryReportId: string | null;
  /**
   * When the send a Retry would replay was COMMITTED — the age the provider's idempotency window is
   * measured against.
   *
   * Separate from `sentAt` for the same reason `sendRetryReportId` is separate from `reportId`: once a
   * correction has been drafted over a failed send the live row is the unsent clone, whose `sent_at` is
   * null. A caller measuring the dedupe window off `sentAt` reads that null as "outside the window" and
   * warns the PM that retrying will put a second copy in the client's inbox — for a send committed
   * minutes ago, which the provider provably still dedupes. Wrong in the safe direction, but it teaches a
   * PM to click through the one confirmation on this page that is ever real.
   */
  sendRetrySentAt: string | null;
  /** Who the week is waiting on, in plain words — the column a director actually reads. */
  waitingOn: string | null;
  dismissalReason: string | null;
}

export interface WeeklyReportDashboard {
  asOf: string;
  rows: WeeklyReportDashboardRow[];
  /**
   * Outstanding weeks older than the lookback window, per project id. Never silently dropped.
   *
   * Both passes contribute: a cadence week nobody filed, and an undelivered send that fell out of the
   * window — including one whose project the cadence no longer generates weeks for at all.
   */
  olderOutstandingCounts: Record<string, number>;
  lookbackWeeks: number;
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

function toDate(value: unknown): Date | null {
  if (value == null) return null;
  const parsed = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/**
 * WHEN THIS DELIVERY WAS LAST HANDED TO THE QUEUE — the moment the stall clock runs from.
 *
 * The LATER of the two stamps, and both are needed:
 *
 *   `sent_at`              the PM's commit. The only timestamp that exists in the case this whole
 *                          mechanism is for, where the job dead-lettered having written nothing at all.
 *   `send_last_attempt_at` written by the worker after every attempt, and — since it is also the only
 *                          record a retry leaves — by `retryWeeklyReportSend` when it re-queues.
 *
 * Ageing off `sent_at` alone is what made every legitimate retry read as a failure. `sent_at` is stamped
 * once at commit and never moves, so a send committed ninety minutes ago and retried five seconds ago was
 * still ninety minutes old by that measure: the chip flipped straight from "Send failed" to "Send stuck",
 * the PM got no acknowledgement that their click had done anything, and past the provider's dedupe window
 * a PM who clicked Retry, cleared the duplicate-risk confirmation and saw nothing change would reasonably
 * click it again — a second acknowledged replay, which is a second real copy in the client's inbox.
 *
 * A row with neither stamp cannot be aged and is left alone rather than guessed at: `sent` guarantees
 * `sent_at`, so that is a corrupt row and inventing a failure for it would be a chip nobody can act on.
 */
function lastSendActivityAt(row: { sent_at?: unknown; send_last_attempt_at?: unknown }): Date | null {
  const sentAt = toDate(row.sent_at);
  const lastAttemptAt = toDate(row.send_last_attempt_at);
  if (sentAt == null) return lastAttemptAt;
  if (lastAttemptAt == null) return sentAt;
  return lastAttemptAt.getTime() > sentAt.getTime() ? lastAttemptAt : sentAt;
}

/** Has this send been undelivered for longer than a delivery plausibly takes? */
function isStalledSend(row: { sent_at?: unknown; send_last_attempt_at?: unknown }, now: Date): boolean {
  const since = lastSendActivityAt(row);
  if (since == null) return false;
  return now.getTime() - since.getTime() > WEEKLY_REPORT_SEND_STALL_MINUTES * 60_000;
}

const REPORT_STATE_BY_STATUS: Record<string, WeeklyReportWeekState> = {
  draft: "draft",
  pending_review: "pending_review",
  approved: "approved",
  sent: "sent",
};

function waitingOnFor(row: {
  state: WeeklyReportWeekState;
  trockSuperName: string | null;
  trockPmName: string | null;
}): string | null {
  switch (row.state) {
    case "not_started":
    case "draft":
      return row.trockSuperName ?? "Unassigned superintendent";
    case "pending_review":
    case "approved":
      return row.trockPmName ?? "Unassigned PM";
    default:
      return null;
  }
}

/**
 * The dashboard's row set, GENERATED FROM THE CADENCE and left-joined against reports and dismissals.
 *
 * The generation direction is the whole design. Reading `weekly_reports` and listing what is there
 * answers "what has been written", which is the opposite of the question this page exists for — an
 * untouched week has no row, so the projects nobody has filed for would be exactly the ones that never
 * appear.
 *
 * Five queries total regardless of project count: projects, their live reports, their UNDELIVERED sends,
 * their dismissals, their pauses. The join happens in memory because the expected-week set is generated
 * in TypeScript (shared with the CRM, the app and the reminder worker) rather than in SQL, and duplicating
 * that generator as a recursive CTE would be a second definition of the cadence.
 *
 * The undelivered sends are a SEPARATE query rather than a column on the reports one, because the two ask
 * different questions of different rows: "what is the live version of this week" and "does this week have
 * an email that never got out". They stop being the same row the moment a PM issues a correction over a
 * failed send, which is exactly when the failure used to disappear.
 */
export async function getWeeklyReportDashboard(
  client: QueryExecutor,
  options: { asOf: string; lookbackWeeks?: number; now?: Date },
): Promise<WeeklyReportDashboard> {
  const asOf = options.asOf;
  // Wall-clock, not `asOf`. Whether a delivery is still in flight is a question about the last few
  // minutes, and `asOf` is a calendar DATE the caller may point anywhere.
  const now = options.now ?? new Date();
  // A non-integer must not reach the arithmetic below. `NaN` (from `?lookbackWeeks=abc`) survives both
  // Math.min and Math.max, makes `expected.length - NaN` NaN, and turns both loops into no-ops — the
  // board renders EMPTY, which reads as "nothing outstanding". A fractional value indexes the expected
  // array at a fraction and reads undefined.
  const requested = options.lookbackWeeks;
  const lookbackWeeks =
    requested == null || !Number.isFinite(requested)
      ? DEFAULT_OUTSTANDING_LOOKBACK_WEEKS
      : Math.max(1, Math.min(Math.trunc(requested), 260));

  // EVERY LIVE SETUP, not only the ones still reporting.
  //
  // The CADENCE is still generated for `status = 'active'` alone — a paused or completed project owes
  // nothing, and generating weeks for one would contradict what the CRM told whoever stopped it. What the
  // wider scope buys is the second pass at the bottom: an UNDELIVERED SEND THE CADENCE DOES NOT COVER.
  //
  // That is the common end state, not an edge case. The last report of a job fails to send, the job
  // finishes, somebody marks the setup completed — and with `wrp.status = 'active'` here the board had no
  // row for it in This Week, nothing in the "and N older" tally, and therefore no Retry, while the
  // Projects tab (`listWeeklyReportProjectSummaries`, scoped to `wrp.is_active` alone) kept showing a
  // permanent red "1 not delivered" for it. Two surfaces claiming one definition of "still owed" while
  // disagreeing about which projects it covers.
  const projectsResult = await client.query(
    `SELECT wrp.id, wrp.deal_id, wrp.property_display_name, wrp.client_name, wrp.status,
            wrp.cadence_weekday, wrp.cadence_start_date, wrp.cadence_end_date,
            wrp.trock_pm_user_id, wrp.trock_super_user_id,
            d.name AS deal_name, d.project_number,
            pm.display_name AS trock_pm_name, sup.display_name AS trock_super_name
       FROM weekly_report_projects wrp
       JOIN deals d ON d.id = wrp.deal_id
       LEFT JOIN public.users pm  ON pm.id = wrp.trock_pm_user_id
       LEFT JOIN public.users sup ON sup.id = wrp.trock_super_user_id
      WHERE wrp.is_active`,
  );
  if (projectsResult.rows.length === 0) {
    return { asOf, rows: [], olderOutstandingCounts: {}, lookbackWeeks };
  }

  const projectIds = projectsResult.rows.map((row) => row.id);

  // Only the LIVE version of each week is joined. A superseded report keeps its row for history but must
  // not decide the week's state — the correction that replaced it does.
  const reportsResult = await client.query(
    `SELECT DISTINCT ON (weekly_report_project_id, week_of)
            id, weekly_report_project_id, week_of, status, version, sent_at, send_error,
            send_delivered_at, send_attempts
       FROM weekly_reports
      WHERE weekly_report_project_id = ANY($1::uuid[])
        AND is_active
        AND superseded_by_id IS NULL
      ORDER BY weekly_report_project_id, week_of, version DESC`,
    [projectIds],
  );
  // SENDS THE CLIENT HAS NOT BEEN PROVEN TO HAVE RECEIVED — asked separately, because the query above
  // cannot answer it. That one returns the LIVE version of each week, and the version that failed to send
  // stops being the live one the moment a PM issues a correction over it: the clone is a higher version,
  // neither row is superseded yet (superseding happens at send), so `version DESC` picks the clone and the
  // failure — the chip, the Retry button and the "Send failures" card — silently disappears while a client
  // is still owed their report.
  //
  // `superseded_by_id IS NULL` is what keeps this honest in the other direction: once the correction is
  // actually sent it stamps the original, and the week's outstanding delivery is then the correction's,
  // not a permanent complaint about a version the client no longer needs.
  //
  // Matches weekly_reports_send_undelivered_idx (0226), which was built for exactly this sweep.
  const undeliveredResult = await client.query(
    `SELECT DISTINCT ON (weekly_report_project_id, week_of)
            id, weekly_report_project_id, week_of, version, sent_at, send_error, send_attempts,
            send_last_attempt_at
       FROM weekly_reports
      WHERE weekly_report_project_id = ANY($1::uuid[])
        AND is_active
        AND status = 'sent'
        AND send_delivered_at IS NULL
        AND superseded_by_id IS NULL
      ORDER BY weekly_report_project_id, week_of, version DESC`,
    [projectIds],
  );
  const dismissalsResult = await client.query(
    `SELECT weekly_report_project_id, week_of, reason
       FROM weekly_report_dismissals
      WHERE weekly_report_project_id = ANY($1::uuid[])`,
    [projectIds],
  );
  // Read for the CADENCE loop, whose projects are all `status = 'active'` — so for those nothing is
  // paused RIGHT NOW and these are the stretches they were stopped for and have since come back from.
  // Without them a project paused for six weeks returns owing all six, which is the opposite of what the
  // CRM told whoever paused it. The undelivered pass below generates no expected weeks and needs none of
  // this — it reads the sends that exist, and a pause is precisely one of the reasons a week with a real
  // send in it is no longer generated.
  const pausesResult = await client.query(
    `SELECT weekly_report_project_id, paused_from, resumed_on
       FROM weekly_report_pauses
      WHERE weekly_report_project_id = ANY($1::uuid[])
      ORDER BY weekly_report_project_id, paused_from`,
    [projectIds],
  );

  const reportByKey = new Map<string, Record<string, any>>();
  for (const row of reportsResult.rows) {
    reportByKey.set(`${row.weekly_report_project_id}|${toIsoDate(row.week_of)}`, row);
  }
  const undeliveredByKey = new Map<string, Record<string, any>>();
  for (const row of undeliveredResult.rows) {
    undeliveredByKey.set(`${row.weekly_report_project_id}|${toIsoDate(row.week_of)}`, row);
  }
  const dismissalByKey = new Map<string, Record<string, any>>();
  for (const row of dismissalsResult.rows) {
    dismissalByKey.set(`${row.weekly_report_project_id}|${toIsoDate(row.week_of)}`, row);
  }
  const pausesByProject = new Map<string, WeeklyReportPauseInterval[]>();
  for (const row of pausesResult.rows) {
    const intervals = pausesByProject.get(row.weekly_report_project_id) ?? [];
    intervals.push({ from: toIsoDate(row.paused_from)!, to: toIsoDate(row.resumed_on) });
    pausesByProject.set(row.weekly_report_project_id, intervals);
  }

  const rows: WeeklyReportDashboardRow[] = [];
  const olderOutstandingCounts: Record<string, number> = {};
  /**
   * Every `project|week` THE CADENCE LOOP DECIDED — rendered, tallied, or dropped as settled.
   *
   * The hand-off to the second pass, and it is a set of weeks rather than a set of projects on purpose.
   * `project.status === 'active'` was the earlier test and it answers the wrong question: it asks whether
   * the project is generating weeks at all, when what the second pass needs to know is whether THIS week
   * was one of them. An active setup can perfectly well stop generating a week that already has a send in
   * it — a reporting end date entered after the fact (`cadence_end_date` is deliberately outside
   * `CADENCE_COLUMNS` so PMs can do exactly that, and `updateWeeklyReportProject`'s own 409 tells them
   * to), or a pause spanning it. Both leave the week out of `expected` while the status stays `active`,
   * so the cadence loop never reaches it and a project-level skip sent it nowhere either: no chip, no
   * Retry, not even a tally entry, opposite a Projects tab reading a permanent red "1 not delivered".
   */
  const cadenceDecidedKeys = new Set<string>();

  // Every project here is `status = 'active'`, so nothing is paused RIGHT NOW — see the pauses query.
  const activeProjects = projectsResult.rows.filter((project) => project.status === "active");

  for (const project of activeProjects) {
    const cadenceWeekday = Number(project.cadence_weekday);
    const currentWeekOf = weeklyReportWeekOf(cadenceWeekday, asOf);
    const expected = weeklyReportExpectedWeeks({
      cadenceWeekday,
      cadenceStartDate: toIsoDate(project.cadence_start_date)!,
      cadenceEndDate: toIsoDate(project.cadence_end_date),
      throughDate: currentWeekOf,
      pausedIntervals: pausesByProject.get(project.id) ?? null,
    });
    if (expected.length === 0) continue;
    for (const weekOf of expected) cadenceDecidedKeys.add(`${project.id}|${weekOf}`);

    const cutoffIndex = Math.max(0, expected.length - lookbackWeeks);
    let olderOutstanding = 0;
    // Weeks beyond the window still get counted when they are genuinely outstanding, so the page can
    // surface "and N older" rather than implying the backlog stops at the window edge.
    for (let i = 0; i < cutoffIndex; i += 1) {
      const key = `${project.id}|${expected[i]}`;
      const report = reportByKey.get(key);
      // A `sent` week only counts as settled if the email actually got out. Testing the status alone was
      // the second place a lost send vanished: past the lookback window it was not even in the "and N
      // older" tally, so the page could not so much as hint that something was missing.
      const settled =
        dismissalByKey.has(key) || (report?.status === "sent" && !undeliveredByKey.has(key));
      if (!settled) olderOutstanding += 1;
    }
    if (olderOutstanding > 0) olderOutstandingCounts[project.id] = olderOutstanding;

    for (let i = cutoffIndex; i < expected.length; i += 1) {
      const weekOf = expected[i]!;
      const key = `${project.id}|${weekOf}`;
      const report = reportByKey.get(key);
      const dismissal = dismissalByKey.get(key);
      const isCurrentWeek = weekOf === currentWeekOf;

      const state: WeeklyReportWeekState = report
        ? REPORT_STATE_BY_STATUS[report.status] ?? "not_started"
        : dismissal
          ? "dismissed"
          : "not_started";

      // A `sent` report whose email never reached the client is NOT settled. It is the one failure this
      // feature has no other way of surfacing — nobody is waiting on it, the super has finished, and the
      // client is simply never going to receive their report. Dropping it with the rest of the archive
      // was how a send that failed three weeks ago became invisible on the page that exists to catch it.
      //
      // Read off the UNDELIVERED set rather than off the live report, so a correction drafted over a
      // failed send cannot take the failure off the board with it.
      const undelivered = undeliveredByKey.get(key) ?? null;
      const sendFailed = undelivered != null && undelivered.send_error != null;
      // `send_error == null` is not redundant with the CRM checking `sendFailed` first. This is a
      // PUBLISHED field the deferred T-Rock Cam surface reads directly, and the whole reason the three
      // verdicts are derived here rather than on each client is that the two surfaces must not be able to
      // disagree about what the chip means. Without it a failed send that is also old reports BOTH, and
      // the app would say "Send stuck" — no error to show, nobody to chase — for a delivery that recorded
      // exactly why it failed.
      const sendStalled =
        undelivered != null && undelivered.send_error == null && isStalledSend(undelivered, now);
      const sendPending = undelivered != null && !sendFailed && !sendStalled;

      // A settled week that is not the current one carries no signal — drop it so the page shows what
      // needs attention rather than an ever-growing archive. History lives on the History tab. An
      // undelivered send in ANY of its three shapes is not settled.
      if (
        !isCurrentWeek &&
        (state === "sent" || state === "dismissed") &&
        undelivered == null
      ) {
        continue;
      }

      const base = {
        trockSuperName: project.trock_super_name ?? null,
        trockPmName: project.trock_pm_name ?? null,
      };
      rows.push({
        weeklyReportProjectId: project.id,
        dealId: project.deal_id,
        projectName: project.property_display_name ?? project.deal_name ?? "Untitled project",
        projectNumber: project.project_number ?? null,
        clientName: project.client_name ?? null,
        trockPmUserId: project.trock_pm_user_id ?? null,
        trockSuperUserId: project.trock_super_user_id ?? null,
        ...base,
        weekOf,
        isCurrentWeek,
        state,
        daysLate: state === "sent" || state === "dismissed" ? 0 : weeklyReportDaysLate(weekOf, asOf),
        reportId: report?.id ?? null,
        reportVersion: report ? Number(report.version) : null,
        sentAt: toIsoTimestamp(report?.sent_at),
        // The outstanding delivery's facts when there is one, so a week whose live row is a freshly
        // cloned correction still reports what went wrong on the version that was actually sent.
        sendError: undelivered?.send_error ?? report?.send_error ?? null,
        sendDeliveredAt: toIsoTimestamp(report?.send_delivered_at),
        sendAttempts: Number((undelivered ?? report)?.send_attempts ?? 0),
        sendFailed,
        sendStalled,
        sendPending,
        sendRetryReportId: undelivered?.id ?? null,
        sendRetrySentAt: toIsoTimestamp(undelivered?.sent_at),
        // An undelivered send is waiting on the PM to deal with it. Left null, the column read "—" on the
        // one row on the board that needs a person.
        waitingOn:
          sendFailed || sendStalled
            ? (base.trockPmName ?? "Unassigned PM")
            : waitingOnFor({ state, ...base }),
        dismissalReason: dismissal?.reason ?? null,
      });
    }
  }

  // A WEEK THE CADENCE NO LONGER GENERATES CAN STILL OWE THE CLIENT AN EMAIL.
  //
  // Second pass rather than folding these weeks into the loop above, because the two questions are
  // genuinely different. Above: "which weeks does the cadence say are owed" — a question a paused or
  // completed project has no answer to, and generating one for it would contradict the CRM's own promise
  // that pausing stops the obligation (a completed setup often has no `cadence_end_date` at all, so the
  // generator would simply keep producing weeks forever). Here: "which sends never got out" — which does
  // not depend on the cadence and does not stop mattering when the cadence stops covering the week.
  //
  // The setup's STATUS is not the test; `cadenceDecidedKeys` is. Stopping reporting is only the commonest
  // way a week with an outstanding send drops out of the generated set, not the only one — an active
  // setup given a reporting end date after the failed send, or paused across the week and resumed, lands
  // in exactly the same place with `status = 'active'` throughout, and both are reached through the
  // ordinary PATCH the product recommends.
  //
  // These rows carry the same `sendRetryReportId` as any other, so the Retry that the Projects tab's
  // "1 not delivered" counter implies actually exists on the board, rather than living only on History.
  const projectById = new Map(projectsResult.rows.map((project) => [project.id, project]));
  for (const undelivered of undeliveredResult.rows) {
    const project = projectById.get(undelivered.weekly_report_project_id);
    if (!project) continue;

    const weekOf = toIsoDate(undelivered.week_of)!;
    // Weeks the cadence loop already decided are ITS business — rendered, tallied or settled. Emitting
    // one again here would double every failed send on the board, and the "Send failures" card counts
    // rows, so the number a director acts on would be exactly doubled.
    if (cadenceDecidedKeys.has(`${project.id}|${weekOf}`)) continue;

    const currentWeekOf = weeklyReportWeekOf(Number(project.cadence_weekday), asOf);
    // The SAME window the cadence loop applies, counted in calendar weeks because there is no generated
    // week list to count entries through — see DEFAULT_OUTSTANDING_LOOKBACK_WEEKS. Beyond it the send is
    // tallied rather than rendered, exactly as an undelivered week beyond the cadence loop's cutoff is:
    // a documented parameter that these rows quietly escaped would leave the two passes disagreeing
    // about where "recent" ends on one board.
    if (weekOf < shiftIsoDate(currentWeekOf, -7 * (lookbackWeeks - 1))) {
      olderOutstandingCounts[project.id] = (olderOutstandingCounts[project.id] ?? 0) + 1;
      continue;
    }

    // The LIVE version of the week, exactly as the loop above reads it — so a correction drafted over
    // this failed send still shows as the week's current state while the failure keeps its own facts.
    const report = reportByKey.get(`${project.id}|${weekOf}`);
    const sendFailed = undelivered.send_error != null;
    // The `send_error == null` conjunct is load-bearing HERE IN PARTICULAR, and for the same reason it is
    // in the cadence loop: `sendStalled` is a PUBLISHED field the deferred T-Rock Cam surface reads
    // directly, so the two surfaces must not be able to disagree about what the chip means. On a week the
    // cadence has stopped generating an OLD FAILED send is the typical case rather than the exotic one,
    // so without it these rows routinely report both verdicts and the app says "Send stuck" — no error to
    // show, nobody to chase — for a delivery that recorded exactly why it failed.
    const sendStalled = undelivered.send_error == null && isStalledSend(undelivered, now);

    rows.push({
      weeklyReportProjectId: project.id,
      dealId: project.deal_id,
      projectName: project.property_display_name ?? project.deal_name ?? "Untitled project",
      projectNumber: project.project_number ?? null,
      clientName: project.client_name ?? null,
      trockPmUserId: project.trock_pm_user_id ?? null,
      trockSuperUserId: project.trock_super_user_id ?? null,
      trockSuperName: project.trock_super_name ?? null,
      trockPmName: project.trock_pm_name ?? null,
      weekOf,
      isCurrentWeek: weekOf === currentWeekOf,
      state: report ? REPORT_STATE_BY_STATUS[report.status] ?? "sent" : "sent",
      // Never late. Lateness measures a report the cadence still expects, and it does not expect this
      // one — the row is here for the delivery, not for the week.
      daysLate: 0,
      reportId: report?.id ?? null,
      reportVersion: report ? Number(report.version) : null,
      sentAt: toIsoTimestamp(report?.sent_at),
      sendError: undelivered.send_error ?? null,
      sendDeliveredAt: toIsoTimestamp(report?.send_delivered_at),
      sendAttempts: Number(undelivered.send_attempts ?? 0),
      sendFailed,
      sendStalled,
      sendPending: !sendFailed && !sendStalled,
      sendRetryReportId: undelivered.id,
      sendRetrySentAt: toIsoTimestamp(undelivered.sent_at),
      // Always the PM: the ONLY reason this row exists is a delivery that has to be dealt with, and the
      // superintendent owes nothing for a week the cadence has stopped asking for.
      waitingOn: project.trock_pm_name ?? "Unassigned PM",
      dismissalReason: null,
    });
  }

  // Most overdue first, then SOONEST DUE, then alphabetical. The middle term matters: before their
  // deadlines every row has daysLate === 0, so falling straight to the name would put a Saturday
  // report above one due tomorrow purely because of how it is spelled.
  rows.sort(
    (a, b) =>
      b.daysLate - a.daysLate ||
      a.weekOf.localeCompare(b.weekOf) ||
      a.projectName.localeCompare(b.projectName),
  );

  return { asOf, rows, olderOutstandingCounts, lookbackWeeks };
}

export interface WeeklyReportProjectSummary {
  weeklyReportProjectId: string;
  /** Reports whose email the mail provider ACCEPTED. A committed send that never got out is not one. */
  reportsSent: number;
  lastSentAt: string | null;
  lastSentWeekOf: string | null;
  /**
   * Sends this project committed that have not been delivered — the counter's own contradiction, shown.
   *
   * Without it, narrowing `reportsSent` to delivered sends would make a lost report disappear from BOTH
   * numbers, which is a quieter version of the same lie.
   *
   * SUPERSEDED VERSIONS ARE EXCLUDED, exactly as the board excludes them. A v1 whose email failed and
   * whose correction then reached the client is not an outstanding delivery — the board stops naming it
   * the moment v2 goes out, and a tab that kept counting it would leave a permanent "1 not delivered"
   * beside a week the client has actually received. Two surfaces, one definition of "still owed".
   *
   * The SCOPE matches too, and did not always. This aggregate has always counted every undelivered send
   * on every `wrp.is_active` setup, while the board reached them only through the cadence: rows for
   * `wrp.status = 'active'` projects, and only for the weeks that generator still produces. Two ways to
   * be counted here with no row and no Retry over there, both of them ordinary — a completed or paused
   * project whose last send failed (the common way this feature ends), and an ACTIVE project whose
   * undelivered week the cadence stopped generating, via a reporting end date entered after the fact or a
   * pause spanning it.
   *
   * `getWeeklyReportDashboard` now ACCOUNTS FOR every undelivered send this counter counts, whatever the
   * setup's status and whatever the cadence currently says about the week: a row inside the lookback
   * window, an entry in `olderOutstandingCounts` beyond it. Accounted for, never dropped — which is the
   * strongest claim the two surfaces can share, since the board renders a window and this number does
   * not.
   */
  undeliveredSends: number;
  /** Null when reporting has stopped — paused, completed, or past its cadence end date. */
  nextDueWeekOf: string | null;
}

/**
 * Per-project counters for the Projects tab. One query, aggregated in SQL.
 *
 * COUNTED ON DELIVERY, not on the status. "Reports sent" and "Last sent" are read aloud to clients — a
 * director says "we sent your report on the 13th" — and `status = 'sent'` records only that a PM pressed
 * a button. On its own that was a small overstatement; combined with a send whose outcome was never
 * recorded it stops being cosmetic, because for such a report this tab is the ONLY surface that mentions
 * it at all, and what it said was that the report went out on a day nothing was delivered.
 */
export async function listWeeklyReportProjectSummaries(
  client: QueryExecutor,
  asOf: string,
): Promise<WeeklyReportProjectSummary[]> {
  const result = await client.query(
    `SELECT wrp.id,
            wrp.cadence_weekday,
            wrp.cadence_start_date,
            wrp.cadence_end_date,
            wrp.status,
            COUNT(wr.id) FILTER (
              WHERE wr.status = 'sent' AND wr.send_delivered_at IS NOT NULL)::int AS reports_sent,
            MAX(wr.sent_at) FILTER (
              WHERE wr.status = 'sent' AND wr.send_delivered_at IS NOT NULL)       AS last_sent_at,
            MAX(wr.week_of) FILTER (
              WHERE wr.status = 'sent' AND wr.send_delivered_at IS NOT NULL)       AS last_sent_week_of,
            COUNT(wr.id) FILTER (
              WHERE wr.status = 'sent'
                AND wr.send_delivered_at IS NULL
                AND wr.superseded_by_id IS NULL)::int                              AS undelivered_sends
       FROM weekly_report_projects wrp
       LEFT JOIN weekly_reports wr
              ON wr.weekly_report_project_id = wrp.id AND wr.is_active
      WHERE wrp.is_active
      GROUP BY wrp.id, wrp.cadence_weekday, wrp.cadence_start_date, wrp.cadence_end_date, wrp.status`,
  );

  return result.rows.map((row) => {
    // A paused, completed or past-its-end-date project owes nothing. Printing a next-due date for one
    // would contradict the board, which excludes it from the cadence entirely.
    //
    // Computed from the LATER of today and the cadence start, so a setup that begins next month reports
    // its first real obligation rather than a date inside a window that has not opened — the board
    // correctly generates nothing for that date, and the two must not disagree.
    const startDate = toIsoDate(row.cadence_start_date)!;
    const anchor = startDate > asOf ? startDate : asOf;
    const nextDue = weeklyReportWeekOf(Number(row.cadence_weekday), anchor);
    const endDate = toIsoDate(row.cadence_end_date);
    const stopped = row.status !== "active" || (endDate != null && nextDue > endDate);

    return {
      weeklyReportProjectId: row.id,
      reportsSent: Number(row.reports_sent ?? 0),
      lastSentAt: toIsoTimestamp(row.last_sent_at),
      lastSentWeekOf: toIsoDate(row.last_sent_week_of),
      undeliveredSends: Number(row.undelivered_sends ?? 0),
      nextDueWeekOf: stopped ? null : nextDue,
    };
  });
}

/**
 * Write off a week that was genuinely missed.
 *
 * Validated rather than trusted, because an unchecked insert lets a caller PRE-dismiss a future date:
 * the week later enters the generated board already settled, having never been missed and never been
 * anybody's problem. That is exactly the accountability the ledger exists to create, so the three
 * conditions below are the feature, not defensive noise — the week must be a real cadence date for
 * this project, it must already be due, and it must not already have a live report.
 */
export async function dismissWeeklyReportWeek(
  client: QueryExecutor,
  input: {
    weeklyReportProjectId: string;
    weekOf: string;
    reason: string;
    actorUserId: string;
    asOf: string;
  },
): Promise<void> {
  const projectResult = await client.query(
    `SELECT cadence_weekday, cadence_start_date, cadence_end_date
       FROM weekly_report_projects WHERE id = $1::uuid AND is_active LIMIT 1`,
    [input.weeklyReportProjectId],
  );
  const project = projectResult.rows[0];
  if (!project) throw new AppError(404, "Weekly report project not found");

  const cadenceWeekday = Number(project.cadence_weekday);
  if (weeklyReportWeekOf(cadenceWeekday, input.weekOf) !== input.weekOf) {
    throw new AppError(400, "That date is not one of this project's reporting days");
  }
  const start = toIsoDate(project.cadence_start_date)!;
  const end = toIsoDate(project.cadence_end_date);
  if (input.weekOf < start || (end && input.weekOf > end)) {
    throw new AppError(400, "That week falls outside this project's reporting window");
  }
  if (input.weekOf > input.asOf) {
    throw new AppError(400, "A future week cannot be dismissed before it is due");
  }

  const existing = await client.query(
    `SELECT id FROM weekly_reports
      WHERE weekly_report_project_id = $1::uuid AND week_of = $2::date AND is_active
      LIMIT 1`,
    [input.weeklyReportProjectId, input.weekOf],
  );
  if (existing.rows[0]) {
    throw new AppError(409, "That week already has a report — finish or discard it instead");
  }
  // ON CONFLICT DO UPDATE rather than DO NOTHING: re-dismissing a week with a better reason should
  // replace the note, not silently keep the first one somebody typed.
  await client.query(
    `INSERT INTO weekly_report_dismissals (weekly_report_project_id, week_of, reason, dismissed_by)
     VALUES ($1::uuid, $2::date, $3, $4::uuid)
     ON CONFLICT (weekly_report_project_id, week_of) DO UPDATE
        SET reason = EXCLUDED.reason,
            dismissed_by = EXCLUDED.dismissed_by,
            dismissed_at = now()`,
    [input.weeklyReportProjectId, input.weekOf, input.reason, input.actorUserId],
  );
}
