import { weeklyReportDeliveryFailed } from "@trock-crm/shared/lib/weeklyReportDelivery";
import {
  WEEKLY_REPORT_VIEW_RETENTION_MONTHS,
  summariseWeeklyReportViews,
  weeklyReportWasOpenedByAPerson,
  type WeeklyReportViewEvent,
  type WeeklyReportViewSession,
} from "@trock-crm/shared/lib/weeklyReportViews";
import { AppError } from "../../middleware/error-handler.js";
import { getWeeklyReportProject, type QueryExecutor, type WeeklyReportProject } from "./projects-service.js";

/**
 * THE LIFETIME OF ONE PROJECT'S REPORTING, as a record somebody can be shown.
 *
 * Every fact here was already being written — `authored_by`, `submitted_by`, `reviewed_by`, `sent_by` and
 * their timestamps since 0222, the delivery verdict since 0227, the reminder ledger since 0222 and the
 * pause ledger since 0223. None of it was ever surfaced. The Projects tab offered a row with an Edit
 * button and no way in, so "when did the client actually get week 8, and who approved it" was a question
 * only answerable with SQL.
 *
 * The TIMELINE IS BUILT HERE, not in the browser. Ordering and wording are the substance of an audit
 * trail — "approved" and "sent" are different acts by potentially different people, and a bounce is not a
 * delivery — and a second implementation on the client is a second set of answers to those questions.
 */

/** One thing that happened, in the order it happened. */
export interface WeeklyReportAuditEvent {
  /** Machine-readable, so the client picks the icon and tone without re-deriving meaning from prose. */
  type:
    | "drafted"
    | "submitted"
    | "approved"
    | "sent"
    | "accepted"
    | "delivered"
    | "delayed"
    | "failed"
    | "retried"
    | "alerted"
    | "superseded";
  at: string;
  /** Display name of whoever did it. Null for events nobody performed — a provider verdict, a timeout. */
  actorName: string | null;
  /** One line of specifics: recipients, a bounce reason, an attempt count. */
  detail: string | null;
}

export interface WeeklyReportAuditReport {
  id: string;
  weekOf: string;
  version: number;
  status: string;
  /** Set when a correction was drafted over this version — the audit trail's own supersede chain. */
  supersededById: string | null;
  /** Who the send was addressed to, off the stored send request. Null before a send is composed. */
  recipients: string[] | null;
  /** The provider's last word: `delivered | bounced | complained | failed | delayed`, or null. */
  deliveryStatus: string | null;
  /**
   * When this version was committed to the client. Carried explicitly rather than dug out of `events`,
   * because the page compares it against the log's retention boundary to tell "nobody opened it" from
   * "nothing was recorded" — a judgement that should not depend on parsing a timeline for one entry.
   */
  sentAt: string | null;
  /**
   * Every access to this report's share link, grouped into sittings and judged.
   *
   * The judgement matters more than the count: a client's mail security fetches the link within seconds
   * of delivery, so a raw open count is mostly robots. See shared/lib/weeklyReportViews.
   */
  viewSessions: WeeklyReportViewSession[];
  /** Did anybody demonstrably READ it — loaded the photos, or pulled the PDF. */
  openedByAPerson: boolean;
  /**
   * True when this report had more accesses than the page loads, so the sessions shown are the earliest
   * rather than all of them. Surfaced rather than swallowed: a truncated log that does not say so reads
   * as a complete one.
   */
  viewSessionsTruncated: boolean;
  /** True when the CRM has no evidence the client received this. Drives the one summary chip. */
  undelivered: boolean;
  /**
   * True when this row is a delivery problem somebody still has to act on.
   *
   * DERIVED HERE ON PURPOSE. The summary count, the card's chip and the card's border are three
   * renderings of this one fact, and when each derived it for itself they disagreed twice on this PR —
   * once with the count calling a resolved week a failure, once with the border doing the same. They
   * now read a single boolean, so disagreeing is no longer something a future edit can express.
   */
  outstanding: boolean;
  events: WeeklyReportAuditEvent[];
}

/** A week the cadence asked for that nobody filed, and somebody explicitly wrote off. */
export interface WeeklyReportAuditDismissal {
  weekOf: string;
  reason: string | null;
  actorName: string | null;
  at: string;
}

/** A stretch during which the project owed nothing. Open-ended while `resumedOn` is null. */
export interface WeeklyReportAuditPause {
  pausedFrom: string;
  resumedOn: string | null;
  pausedByName: string | null;
  resumedByName: string | null;
}

export interface WeeklyReportAuditReminder {
  weekOf: string;
  kind: string;
  at: string;
}

export interface WeeklyReportProjectAudit {
  project: WeeklyReportProject;
  /** Every version of every week, newest week first and newest version first within a week. */
  reports: WeeklyReportAuditReport[];
  reminders: WeeklyReportAuditReminder[];
  dismissals: WeeklyReportAuditDismissal[];
  pauses: WeeklyReportAuditPause[];
  /**
   * The oldest moment the access log can speak about — the later of "the table existed" and "retention
   * still covers it". A report sent before this has an empty session list because nothing was RECORDED,
   * not because nobody opened it, and the page must say so rather than assert the negative.
   */
  viewTrackingSince: string | null;
}

/**
 * How many accesses one report contributes to the audit page.
 *
 * Far above anything a real report produces — a client's mail security fetches a handful and their staff
 * a few more — and far below what an unauthenticated route can be made to generate.
 */
const WEEKLY_REPORT_VIEW_READ_CAP = 500;

function toIso(value: unknown): string | null {
  if (value == null) return null;
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

function toIsoDate(value: unknown): string | null {
  if (value == null) return null;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === "string") return value.slice(0, 10);
  return null;
}

/** The addresses a send was composed for, off the stored request. Shape-checked: it is free-form jsonb. */
function recipientsOf(sendRequest: unknown): string[] | null {
  if (!sendRequest || typeof sendRequest !== "object") return null;
  const to = (sendRequest as { to?: unknown }).to;
  if (!Array.isArray(to)) return null;
  const addresses = to.filter((entry): entry is string => typeof entry === "string" && entry.length > 0);
  return addresses.length > 0 ? addresses : null;
}

/**
 * Turn one report row into its timeline.
 *
 * Ordered by WHEN EACH THING HAPPENED rather than by a fixed lifecycle sequence, because the two diverge:
 * a report can be approved, sent, fail, be retried and bounce, and a retry's timestamp is later than the
 * send it repeats. Sorting by time is the only ordering that stays honest when the happy path is departed
 * from — which is exactly when somebody is reading this page.
 */
function buildEvents(row: Record<string, any>): WeeklyReportAuditEvent[] {
  const events: WeeklyReportAuditEvent[] = [];
  const push = (
    type: WeeklyReportAuditEvent["type"],
    at: unknown,
    actorName: string | null,
    detail: string | null = null,
  ) => {
    const iso = toIso(at);
    if (iso) events.push({ type, at: iso, actorName, detail });
  };

  push("drafted", row.authored_at, row.authored_by_name ?? null);
  push("submitted", row.submitted_at, row.submitted_by_name ?? null, "Sent to the PM for review");
  push("approved", row.reviewed_at, row.reviewed_by_name ?? null);

  const recipients = recipientsOf(row.send_request);
  push(
    "sent",
    row.sent_at,
    row.sent_by_name ?? null,
    recipients ? `To ${recipients.join(", ")}` : null,
  );

  // Two separate facts, deliberately. `send_delivered_at` is the provider ACCEPTING the message;
  // `send_delivery_status` is what it said afterwards. A message can be accepted and then hard-bounce,
  // and collapsing the two would render that as an ordinary delivery.
  push("accepted", row.send_delivered_at, null, "The mail provider accepted the message");

  const status = row.send_delivery_status as string | null;
  if (status) {
    const detail = row.send_delivery_detail as Record<string, unknown> | null;
    const reason =
      typeof detail?.message === "string" && detail.message
        ? detail.message
        : typeof detail?.bounceSubType === "string" && detail.bounceSubType
          ? detail.bounceSubType
          : null;
    // THREE outcomes, not two. A binary "failure or delivered" split sent `delayed` — which the shared
    // vocabulary defines as "the provider is still trying, and explicitly not a failure" — down the
    // delivered branch, so a report still in flight was reported to a director as having reached the
    // client. That is the same mistake as reading acceptance for delivery, one field over.
    //
    // `complained` DOES belong on the delivered branch: a spam complaint can only follow a delivery, so
    // the client has the report. The word itself still prints in the detail line, because "delivered,
    // and they marked it as spam" is a different thing to know than "delivered".
    const type = weeklyReportDeliveryFailed(status)
      ? "failed"
      : status === "delayed"
        ? "delayed"
        : "delivered";
    push(type, row.send_delivery_status_at, null, reason ? `${status} — ${reason}` : status);
  }

  // A retry only reads as an event when it is DISTINCT from the original send; otherwise every ordinary
  // one-attempt send would grow a redundant "attempt 1" line under its own timestamp.
  const attempts = Number(row.send_attempts ?? 0);
  if (attempts > 1 && toIso(row.send_last_attempt_at) !== toIso(row.sent_at)) {
    push(
      "retried",
      row.send_last_attempt_at,
      null,
      row.send_error ? `Attempt ${attempts} — ${row.send_error}` : `Attempt ${attempts}`,
    );
  }

  push("alerted", row.send_stall_alerted_at, null, "Leadership was told this send stopped moving");

  if (row.superseded_by_id) {
    // Timestamped off the replacement's own creation, not this row's updated_at, which moves for any
    // edit at all and would date the supersede to whenever somebody last touched the old version.
    push("superseded", row.superseded_at, null, "A correction was drafted over this version");
  }

  return events.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
}

/** The provider's word that it arrived. `complained` counts — they got it and then disliked it. */
function receiptConfirmed(status: unknown): boolean {
  return status === "delivered" || status === "complained";
}

/**
 * Which rows are a delivery problem somebody still has to act on.
 *
 * A row qualifies when nothing has replaced it AND either:
 *
 *   • it is itself undelivered — bounced, still in transit, or never accepted at all; or
 *   • it was sent, has no confirmation of receipt, and A PREVIOUS VERSION OF THAT WEEK FAILED.
 *
 * The second clause is Greptile's finding on this PR, and it is the narrow half of a real trade.
 * Excluding superseded rows outright was right for `v1 bounced → v2 delivered`, which is a resolved
 * week, and wrong for `v1 bounced → v2 accepted, no verdict yet`: the provider accepting a correction
 * is not the client receiving it, so a week whose only hard evidence was a bounce read as fully
 * settled. Requiring a KNOWN prior failure is what keeps this off the ordinary case — a first send
 * sitting at accepted-with-no-verdict has nothing behind it and stays quiet, which is the whole reason
 * `undelivered` does not flag that state either. Without it every report would go red for its first
 * minutes.
 *
 * A FAILURE IS SPENT ONCE SOMETHING LATER ARRIVES, which is why this compares versions rather than
 * asking "did anything fail". Greptile's second finding: `v1 bounced → v2 delivered → v3 accepted` was
 * being flagged off v1, a bounce the client's copy of v2 had already made irrelevant, so a week they
 * demonstrably received read as unresolved forever. Versions order the same way sends do — a
 * correction always takes a higher number, and `sendWeeklyReport` stamps the supersede at send — so
 * "later than the last confirmed receipt" is exactly "not yet answered by something that arrived".
 *
 * The unit is the WEEK because the client's position is a property of the week, not of a row: several
 * versions can carry one week, and what matters is where that week got to, not any single attempt.
 */
function markOutstanding(
  reports: Array<Omit<WeeklyReportAuditReport, "outstanding">>,
): WeeklyReportAuditReport[] {
  // Per week: the newest version the client is CONFIRMED to hold, and the newest replaced version that
  // demonstrably failed. Version 0 stands for "never" — real versions start at 1.
  const lastConfirmed = new Map<string, number>();
  const lastFailed = new Map<string, number>();
  const bump = (into: Map<string, number>, weekOf: string, version: number) => {
    into.set(weekOf, Math.max(into.get(weekOf) ?? 0, version));
  };

  for (const report of reports) {
    if (receiptConfirmed(report.deliveryStatus)) bump(lastConfirmed, report.weekOf, report.version);
    // `supersededById != null` CANNOT change the answer for any state the product can reach, and it is
    // kept anyway — deliberately, not by oversight. A live row that failed is already `undelivered` and
    // outstanding on its own account, and nothing soft-deletes an individual report (only the project),
    // so a failed row that is neither live-and-flagged nor superseded does not occur. What it defends
    // is the hand-written UPDATE: prod fixes are applied by hand on this project, and without it a
    // failure orphaned that way would flag its week twice, on the orphan and on the live send both.
    if (report.supersededById != null && weeklyReportDeliveryFailed(report.deliveryStatus)) {
      bump(lastFailed, report.weekOf, report.version);
    }
  }

  return reports.map((report) => ({
    ...report,
    outstanding:
      report.supersededById == null &&
      (report.undelivered ||
        (report.status === "sent" &&
          !receiptConfirmed(report.deliveryStatus) &&
          (lastFailed.get(report.weekOf) ?? 0) > (lastConfirmed.get(report.weekOf) ?? 0))),
  }));
}

/**
 * @throws 404 when the project does not exist or has been soft-deleted.
 *
 * Reports are read WITHOUT an `is_active` filter on purpose: a soft-deleted version is part of what
 * happened, and an audit trail that quietly omits the rows somebody removed is not one.
 */
export async function getWeeklyReportProjectAudit(
  client: QueryExecutor,
  projectId: string,
): Promise<WeeklyReportProjectAudit> {
  const project = await getWeeklyReportProject(client, projectId);
  if (!project) throw new AppError(404, "Weekly report project not found");

  const reports = await client.query(
    `SELECT wr.id, wr.week_of, wr.version, wr.status, wr.superseded_by_id,
            wr.authored_at, wr.submitted_at, wr.reviewed_at, wr.sent_at,
            wr.send_request, wr.send_attempts, wr.send_error, wr.send_last_attempt_at,
            wr.send_delivered_at, wr.send_delivery_status, wr.send_delivery_status_at,
            wr.send_delivery_detail, wr.send_stall_alerted_at,
            author.display_name    AS authored_by_name,
            submitter.display_name AS submitted_by_name,
            reviewer.display_name  AS reviewed_by_name,
            sender.display_name    AS sent_by_name,
            successor.created_at   AS superseded_at
       FROM weekly_reports wr
       LEFT JOIN public.users author    ON author.id    = wr.authored_by
       LEFT JOIN public.users submitter ON submitter.id = wr.submitted_by
       LEFT JOIN public.users reviewer  ON reviewer.id  = wr.reviewed_by
       LEFT JOIN public.users sender    ON sender.id    = wr.sent_by
       LEFT JOIN weekly_reports successor ON successor.id = wr.superseded_by_id
      WHERE wr.weekly_report_project_id = $1::uuid
      ORDER BY wr.week_of DESC, wr.version DESC`,
    [projectId],
  );

  /**
   * Accesses live in `public.weekly_report_views`, not in the tenant schema — a share link is resolved
   * before any office is known, so the log has to be reachable without one. Read through the CALLER'S
   * client all the same: the reference is schema-qualified, and a qualified name does not depend on the
   * search_path. Reaching for the pool coupled this read to a live connection for no gain and took the
   * whole audit page out of the PGlite suites.
   *
   * One query for every report on the project, grouped in memory. A per-report query would be N+1 on a
   * page whose whole job is to be opened and read.
   */
  /**
   * HOW FAR BACK THE ACCESS LOG ACTUALLY REACHES — and the reason it has to be sent to the browser.
   *
   * An empty session list has two completely different meanings and the page cannot tell them apart on
   * its own: nobody opened the report, or nothing about that week was ever recorded. Every report sent
   * before 0231 is in the second category, and so is every report that outlived the retention sweep.
   * Rendering either as "Nobody has opened the link yet" turns a gap in our records into a definitive
   * statement about the client's behaviour — in the one screen built to be quoted back to that client.
   *
   * Two boundaries, and the later one wins because both must hold for the absence to mean anything:
   *
   *   • WHEN LOGGING BEGAN. Read from `_migrations` rather than hardcoded, because the honest answer is
   *     literally the moment the table appeared, it differs per environment, and a constant would go
   *     stale the first time someone rebuilt an office.
   *   • WHAT RETENTION STILL COVERS. The sweep deletes past 24 months, so beyond that an empty list is
   *     expected rather than informative.
   */
  //
  // Two queries rather than one because Postgres resolves relation names at PARSE time: a `CASE` guard
  // around a `SELECT ... FROM public._migrations` still fails outright where that table is absent, which
  // it is in the PGlite suites and in any environment whose schema was built from the SQL files rather
  // than through the runner. A missing ledger must degrade to the retention floor, not 500 the page.
  const retentionFloor = await client.query(
    `SELECT now() - ($1 || ' months')::interval AS floor`,
    [String(WEEKLY_REPORT_VIEW_RETENTION_MONTHS)],
  );
  let viewTrackingSince = toIso(retentionFloor.rows[0]?.floor ?? null);

  const ledger = await client.query(`SELECT to_regclass('public._migrations') AS reg`);
  if (ledger.rows[0]?.reg != null) {
    const applied = await client.query(
      `SELECT executed_at FROM public._migrations WHERE name = '0231_weekly_report_views.sql'`,
    );
    const loggingBegan = toIso(applied.rows[0]?.executed_at ?? null);
    // The LATER of the two: both have to hold before an empty list means anything. Logging starting last
    // month makes an older week unknowable however generous retention is, and vice versa.
    if (loggingBegan && (!viewTrackingSince || Date.parse(loggingBegan) > Date.parse(viewTrackingSince))) {
      viewTrackingSince = loggingBegan;
    }
  }

  const reportIds = reports.rows.map((row) => row.id as string);
  const truncatedReports = new Set<string>();
  // `WeeklyReportViewEvent` rather than a local shape with `eventType: any`: the column's CHECK and the
  // classifier's judgement have to stay in step, and `any` let an unrecognised event_type reach `judge`
  // and be counted as a PDF download. Flagged by CodeRabbit.
  const viewsByReport = new Map<string, WeeklyReportViewEvent[]>();
  if (reportIds.length > 0) {
    // ONLY WHAT HAPPENED AFTER THE CLIENT WAS SENT IT.
    //
    // A link can be minted on an `approved` report — `isWeeklyReportShareableStatus` allows it — so the
    // ordinary way to check a report before it goes out is to open the client's own URL. Those fetches
    // are logged like any other, and a PM who scrolled the photos while checking looks, to the
    // classifier, exactly like a reader at the client: engagement is what distinguishes a person from a
    // scanner, and the PM engaged.
    //
    // Left in, this page would report "opened by someone at the client" about a report the client had
    // not yet been sent. That is not a cosmetic overstatement — it is the CRM manufacturing the evidence
    // it exists to provide, and it would be repeated to a client in a dispute.
    //
    // The rows stay in the table; only the client-open evidence is bounded. An unsent report has no
    // `sent_at` and therefore contributes nothing here, which is right — there is no client access to
    // speak of yet.
    //
    // BOUNDED IN THE DATABASE, not merely capped in the process — and the distinction is the whole
    // point. These rows arrive from a route with no login: 300 requests a minute per address, tokens
    // good for 180 days. How many exist behind one report is a number somebody else chooses.
    //
    // A window function ranked over the partition does NOT bound that work: `row_number()` has to
    // consume and sort every matching row before the outer filter can discard any of them, so the read
    // stayed proportional to the flood even though only 500 rows came back. Two LATERAL reads with
    // LIMITs do bound it — each walks an index in `occurred_at` order and stops.
    //
    // DISPATCH, NOT ENQUEUE. `sent_at` is stamped when the PM commits and the job is queued; the worker
    // does not stamp `send_delivered_at` until the provider accepts the message. Between those two the
    // client has nothing, so a staffer testing the returned share URL in that gap was still admitted as
    // post-send client evidence — the pre-send hole, reopened by a worker backlog. `COALESCE` falls back
    // to `sent_at` only where acceptance never came, which is a send that failed and has no client
    // evidence to misattribute anyway. Caught by Codex.
    //
    // ENGAGEMENT FIRST AND SEPARATELY. A `pdf` or `photo` fetch is what distinguishes a person from a
    // scanner, so those get their own budget off `weekly_report_views_engagement_idx` rather than
    // competing with page requests for one. A real reader buried under scanner traffic keeps their
    // evidence; the page budget answers "did it reach them after we sent it", which is settled early.
    //
    // LIMIT is CAP + 1 rather than CAP, so "is there more than we are showing" is answered by whether
    // the extra row came back. A `count(*)` would have been the obvious way and is exactly the
    // unbounded scan this restructure exists to remove.
    const views = await client.query(
      `SELECT e.weekly_report_id, e.event_type, e.occurred_at, host(e.ip) AS ip, e.user_agent, e.bucket
         FROM unnest($1::uuid[]) AS r(id)
         JOIN weekly_reports wr ON wr.id = r.id AND wr.sent_at IS NOT NULL
        CROSS JOIN LATERAL (
                (SELECT v.weekly_report_id, v.event_type, v.occurred_at, v.ip, v.user_agent,
                        'engagement' AS bucket
                   FROM public.weekly_report_views v
                  WHERE v.weekly_report_id = r.id
                    AND v.occurred_at >= COALESCE(wr.send_delivered_at, wr.sent_at)
                    AND v.event_type IN ('pdf', 'photo')
                  ORDER BY v.occurred_at
                  LIMIT $2)
                UNION ALL
                (SELECT v.weekly_report_id, v.event_type, v.occurred_at, v.ip, v.user_agent,
                        'page' AS bucket
                   FROM public.weekly_report_views v
                  WHERE v.weekly_report_id = r.id
                    AND v.occurred_at >= COALESCE(wr.send_delivered_at, wr.sent_at)
                    AND v.event_type NOT IN ('pdf', 'photo')
                  ORDER BY v.occurred_at
                  LIMIT $2)
        ) AS e
        ORDER BY e.occurred_at ASC`,
      [reportIds, WEEKLY_REPORT_VIEW_READ_CAP + 1],
    );

    // The CAP + 1th row of either bucket is the signal, and it is dropped rather than shown: it exists
    // only to answer "is there more".
    const bucketCounts = new Map<string, { engagement: number; page: number }>();
    for (const row of views.rows) {
      const counts = bucketCounts.get(row.weekly_report_id) ?? { engagement: 0, page: 0 };
      if (row.bucket === "engagement") counts.engagement += 1;
      else counts.page += 1;
      bucketCounts.set(row.weekly_report_id, counts);
    }
    for (const [reportId, counts] of bucketCounts) {
      if (counts.engagement > WEEKLY_REPORT_VIEW_READ_CAP || counts.page > WEEKLY_REPORT_VIEW_READ_CAP) {
        truncatedReports.add(reportId);
      }
    }
    const kept = new Map<string, { engagement: number; page: number }>();
    for (const row of views.rows) {
      // The CAP + 1th row of a bucket did its job by arriving. Keeping it would show one more sitting
      // than the cap promises and make the boundary tests depend on an off-by-one.
      const seen = kept.get(row.weekly_report_id) ?? { engagement: 0, page: 0 };
      const isEngagement = row.bucket === "engagement";
      if (isEngagement) seen.engagement += 1;
      else seen.page += 1;
      kept.set(row.weekly_report_id, seen);
      const rank = isEngagement ? seen.engagement : seen.page;
      if (rank > WEEKLY_REPORT_VIEW_READ_CAP) continue;

      const bucket = viewsByReport.get(row.weekly_report_id) ?? [];
      // Stored back, always. `get(...) ?? []` hands back a NEW array on a miss, so pushing to it without
      // setting it discards every first event for every report — silently: the page then renders "never
      // opened" for a report that was, which is the exact wrong answer in a dispute.
      viewsByReport.set(row.weekly_report_id, bucket);
      bucket.push({
        eventType: row.event_type as WeeklyReportViewEvent["eventType"],
        occurredAt: toIso(row.occurred_at)!,
        // `host()` strips the /32 that `inet` renders, so the audit page shows 73.162.44.219 rather
        // than 73.162.44.219/32 — which reads as a subnet to anybody who knows what one is.
        ip: row.ip ?? null,
        userAgent: row.user_agent ?? null,
      });
    }
  }

  const reminders = await client.query(
    `SELECT week_of, kind, sent_at FROM weekly_report_reminders_sent
      WHERE weekly_report_project_id = $1::uuid
      ORDER BY sent_at DESC`,
    [projectId],
  );

  const dismissals = await client.query(
    `SELECT d.week_of, d.reason, d.dismissed_at, u.display_name AS actor_name
       FROM weekly_report_dismissals d
       LEFT JOIN public.users u ON u.id = d.dismissed_by
      WHERE d.weekly_report_project_id = $1::uuid
      ORDER BY d.dismissed_at DESC`,
    [projectId],
  );

  const pauses = await client.query(
    `SELECT p.paused_from, p.resumed_on,
            pb.display_name AS paused_by_name,
            rb.display_name AS resumed_by_name
       FROM weekly_report_pauses p
       LEFT JOIN public.users pb ON pb.id = p.paused_by
       LEFT JOIN public.users rb ON rb.id = p.resumed_by
      WHERE p.weekly_report_project_id = $1::uuid
      ORDER BY p.paused_from DESC`,
    [projectId],
  );

  return {
    project,
    reports: markOutstanding(
      reports.rows.map((row) => ({
        id: row.id,
        weekOf: toIsoDate(row.week_of)!,
        version: Number(row.version),
        status: row.status,
        supersededById: row.superseded_by_id ?? null,
        recipients: recipientsOf(row.send_request),
        deliveryStatus: row.send_delivery_status ?? null,
        sentAt: toIso(row.sent_at),
        // "Sent, and no evidence it arrived." A bounce counts: the provider accepted the message, so
        // send_delivered_at IS set, and any predicate keyed on that alone reads a bounce as a success.
        // "The CRM has no evidence the client received this."
        //   • never accepted by the provider          -> no evidence
        //   • bounced / failed                        -> evidence AGAINST
        //   • delayed                                 -> still trying; the client does not have it yet
        //   • accepted, webhook silent (status null)  -> the ordinary pre-verdict case, NOT flagged, or
        //                                                every report would go red for its first minutes
        //   • delivered / complained                  -> they have it
        undelivered:
          row.status === "sent" &&
          (row.send_delivered_at == null ||
            weeklyReportDeliveryFailed(row.send_delivery_status) ||
            row.send_delivery_status === "delayed"),
        events: buildEvents(row),
        ...(() => {
          // Classified against THIS report's own send time — the "arrived seconds after the email"
          // signal is meaningless measured against any other report's.
          const sessions = summariseWeeklyReportViews(
            viewsByReport.get(row.id) ?? [],
            // The same instant the filter uses. Measuring the 90-second scanner window from the enqueue
            // while filtering from acceptance would put the two rules on different clocks.
            toIso(row.send_delivered_at ?? row.sent_at),
          );
          return {
            viewSessions: sessions,
            openedByAPerson: weeklyReportWasOpenedByAPerson(sessions),
            viewSessionsTruncated: truncatedReports.has(row.id),
          };
        })(),
      })),
    ),
    reminders: reminders.rows.map((row) => ({
      weekOf: toIsoDate(row.week_of)!,
      kind: row.kind,
      at: toIso(row.sent_at)!,
    })),
    dismissals: dismissals.rows.map((row) => ({
      weekOf: toIsoDate(row.week_of)!,
      reason: row.reason ?? null,
      actorName: row.actor_name ?? null,
      at: toIso(row.dismissed_at)!,
    })),
    viewTrackingSince,
    pauses: pauses.rows.map((row) => ({
      pausedFrom: toIsoDate(row.paused_from)!,
      resumedOn: toIsoDate(row.resumed_on),
      pausedByName: row.paused_by_name ?? null,
      resumedByName: row.resumed_by_name ?? null,
    })),
  };
}
