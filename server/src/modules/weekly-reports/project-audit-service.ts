import { WEEKLY_REPORT_DELIVERY_FAILURE_STATUSES } from "@trock-crm/shared/lib/weeklyReportDelivery";
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
  /** True when the CRM has no evidence the client received this. Drives the one summary chip. */
  undelivered: boolean;
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
}

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
    const failed = (WEEKLY_REPORT_DELIVERY_FAILURE_STATUSES as readonly string[]).includes(status);
    const detail = row.send_delivery_detail as Record<string, unknown> | null;
    const reason =
      typeof detail?.message === "string" && detail.message
        ? detail.message
        : typeof detail?.bounceSubType === "string" && detail.bounceSubType
          ? detail.bounceSubType
          : null;
    push(
      failed ? "failed" : "delivered",
      row.send_delivery_status_at,
      null,
      reason ? `${status} — ${reason}` : status,
    );
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
    reports: reports.rows.map((row) => ({
      id: row.id,
      weekOf: toIsoDate(row.week_of)!,
      version: Number(row.version),
      status: row.status,
      supersededById: row.superseded_by_id ?? null,
      recipients: recipientsOf(row.send_request),
      deliveryStatus: row.send_delivery_status ?? null,
      // "Sent, and no evidence it arrived." A bounce counts: the provider accepted the message, so
      // send_delivered_at IS set, and any predicate keyed on that alone reads a bounce as a success.
      undelivered:
        row.status === "sent" &&
        (row.send_delivered_at == null ||
          (WEEKLY_REPORT_DELIVERY_FAILURE_STATUSES as readonly string[]).includes(
            row.send_delivery_status ?? "",
          )),
      events: buildEvents(row),
    })),
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
    pauses: pauses.rows.map((row) => ({
      pausedFrom: toIsoDate(row.paused_from)!,
      resumedOn: toIsoDate(row.resumed_on),
      pausedByName: row.paused_by_name ?? null,
      resumedByName: row.resumed_by_name ?? null,
    })),
  };
}
