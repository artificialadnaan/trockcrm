import crypto from "node:crypto";
import {
  WEEKLY_REPORT_SEND_LIMITS,
  normalizeWeeklyReportRecipients,
  weeklyReportDefaultContextParagraph,
  weeklyReportEmailBodyText,
  weeklyReportEmailSubject,
  weeklyReportGreeting,
  type WeeklyReportRecipientOption,
  type WeeklyReportSenderContact,
} from "@trock-crm/shared/lib/weeklyReportEmail";
import { canTransitionWeeklyReport } from "@trock-crm/shared/types";
import { AppError } from "../../middleware/error-handler.js";
import { WEEKLY_REPORT_CLIENT_ROLES, type QueryExecutor } from "./projects-service.js";
import {
  canPublishWeeklyReport,
  getWeeklyReportDetail,
  transitionWeeklyReport,
  type WeeklyReportActor,
  type WeeklyReportDetail,
} from "./reports-service.js";
import { mintWeeklyReportToken } from "./tokens-service.js";

// The send flow: compose the email SERVER-SIDE, commit the transition, mint the link, queue the delivery.
//
// The composition lives here rather than on a client because the PM may review from the CRM or from
// T-Rock Cam, and the spec's guarantee that the modal is identical on both is only true if neither of them
// writes the subject or the body. Both fetch this draft, render it, and post the same mutation back.
//
// The DELIVERY is a queued job, not part of the request. Rendering a PDF and talking to a mail provider is
// seconds of work; doing it inline would hold a pooled connection across both (the documented cause of
// "Couldn't load deals") and would make the PM wait on a mail server to find out whether their click
// worked. What the request DOES do synchronously is mint the token — the modal has to be able to show the
// real URL, and a link that appears a minute later is not a link the PM can copy to anyone.

/** The word `job_queue.job_type` carries. Duplicated in the worker; the server cannot import from it. */
export const WEEKLY_REPORT_SEND_JOB = "weekly_report_send";

/**
 * The composed draft, returned as DATA.
 *
 * `recipients` is the pre-filled selection; `recipientOptions` is everything the client team offers, so the
 * modal can show an unchecked row for a role that has an address rather than making the PM retype it.
 */
export interface WeeklyReportSendDraft {
  reportId: string;
  weekOf: string;
  version: number;
  isCorrection: boolean;
  propertyName: string | null;
  recipients: string[];
  recipientOptions: WeeklyReportRecipientOption[];
  subject: string;
  greeting: string;
  /** The one part the PM edits. */
  contextParagraph: string;
  sender: WeeklyReportSenderContact;
  attachPdf: boolean;
  /**
   * The link as it WILL read once minted, or null before the report is sent.
   *
   * Null is the honest answer for an unsent report: the raw token exists exactly once, at send, and only
   * its hash is stored — so there is no way to show a working link before the PM commits to sending one.
   * The modal says so rather than showing a fake.
   */
  shareUrl: string | null;
  /** The exact plain-text body the client will receive, given the values above. Preview, not input. */
  bodyPreview: string;
}

/** What the PM posts back. Everything is re-validated; nothing here is trusted. */
export interface WeeklyReportSendPayload {
  recipients?: unknown;
  subject?: unknown;
  contextParagraph?: unknown;
  attachPdf?: unknown;
}

/** Frozen onto the report row, and the ONLY thing the worker reads when it builds the message. */
export interface WeeklyReportSendRequest {
  recipients: string[];
  subject: string;
  greetingName: string | null;
  contextParagraph: string;
  shareUrl: string;
  sender: WeeklyReportSenderContact;
  attachPdf: boolean;
  isCorrection: boolean;
  requestedBy: string;
  requestedAt: string;
  requestVersion: 1;
}

export interface WeeklyReportSendOffice {
  /** `offices.id` — what public.weekly_report_tokens.tenant_id and job_queue.office_id both hold. */
  tenantId: string;
  /** The office slug, i.e. the `office_<slug>` schema the worker must read. */
  slug: string;
}

function text(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function toIsoDate(value: unknown): string | null {
  if (value == null) return null;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === "string") return value.slice(0, 10);
  return null;
}

/**
 * Load the report and its setup row, LOCKING both.
 *
 * The same reasoning as `loadPublishableReport` in routes.ts: the two facts this decision rests on — the
 * report's status and who the assigned PM is — are mutable by other requests, and this one both hands out
 * a durable public credential and moves the report into a terminal state. Read without the lock, a PM
 * could pass the check, lose the assignment, and still have queued a client email.
 */
async function loadSendTarget(client: QueryExecutor, reportId: string) {
  const locked = await client.query(
    `SELECT * FROM weekly_reports WHERE id = $1::uuid AND is_active FOR UPDATE`,
    [reportId],
  );
  const reportRow = locked.rows[0];
  if (!reportRow) throw new AppError(404, "Weekly report not found");

  const lockedProject = await client.query(
    `SELECT wrp.*,
            pm.display_name AS trock_pm_name,
            pm.email        AS trock_pm_email,
            pm.phone        AS trock_pm_phone
       FROM weekly_report_projects wrp
       LEFT JOIN public.users pm ON pm.id = wrp.trock_pm_user_id
      WHERE wrp.id = $1::uuid AND wrp.is_active
      FOR UPDATE OF wrp`,
    [reportRow.weekly_report_project_id],
  );
  const projectRow = lockedProject.rows[0];
  if (!projectRow) throw new AppError(404, "Weekly report project not found");
  return { reportRow, projectRow };
}

/** DOC, PM, RM, CM — the reference report's order — keeping only the roles that carry an address. */
function recipientOptionsFrom(projectRow: Record<string, any>): WeeklyReportRecipientOption[] {
  const options: WeeklyReportRecipientOption[] = [];
  for (const role of WEEKLY_REPORT_CLIENT_ROLES) {
    const email = text(projectRow[`client_${role}_email`]);
    if (!email) continue;
    options.push({ role: role.toUpperCase(), name: text(projectRow[`client_${role}_name`]), email });
  }
  return options;
}

function senderFrom(projectRow: Record<string, any>): WeeklyReportSenderContact {
  return {
    name: text(projectRow.trock_pm_name),
    email: text(projectRow.trock_pm_email),
    phone: text(projectRow.trock_pm_phone),
  };
}

/**
 * Who the greeting names.
 *
 * The first SELECTED recipient that maps to a client-team role, so removing the DOC and leaving only the
 * client's PM re-addresses the greeting to them rather than continuing to greet somebody who is no longer
 * on the email. A free-typed address matches no role and leaves the greeting generic, which is right — the
 * platform does not know whose mailbox it is.
 */
function greetingNameFor(
  options: WeeklyReportRecipientOption[],
  recipients: string[],
): string | null {
  const byEmail = new Map(options.map((option) => [option.email.toLowerCase(), option]));
  for (const recipient of recipients) {
    const match = byEmail.get(recipient.toLowerCase());
    if (match?.name) return match.name;
  }
  return null;
}

/**
 * The share URL already in front of this client, if any.
 *
 * Only for a report that has BEEN sent — the modal reopening on a sent report shows the link that went
 * out, so "copy client link" and the send record agree. It reads the stored request rather than the token
 * table because the token table holds only hashes; the URL is unrecoverable from it by design.
 */
function storedShareUrl(reportRow: Record<string, any>): string | null {
  const request = reportRow.send_request;
  if (!request || typeof request !== "object") return null;
  return text((request as Record<string, unknown>).shareUrl);
}

/**
 * Compose the send modal, server-side.
 *
 * Readable by anyone who may publish the report (the assigned PM or leadership) — the same gate the send
 * itself takes, because the draft exposes the client's contact addresses and the PM's phone number.
 */
export async function buildWeeklyReportSendDraft(
  client: QueryExecutor,
  reportId: string,
  actor: WeeklyReportActor,
): Promise<WeeklyReportSendDraft> {
  const { reportRow, projectRow } = await loadSendTarget(client, reportId);
  if (!canPublishWeeklyReport(projectRow, actor)) {
    throw new AppError(403, "Only the assigned project manager can send this report to the client");
  }

  const weekOf = toIsoDate(reportRow.week_of)!;
  const version = Number(reportRow.version ?? 1);
  const isCorrection = version > 1;
  const propertyName = text(projectRow.property_display_name);
  const options = recipientOptionsFrom(projectRow);
  const recipients = options.map((option) => option.email);
  const sender = senderFrom(projectRow);
  const contextParagraph = weeklyReportDefaultContextParagraph({ propertyName, weekOf, isCorrection });
  const shareUrl = storedShareUrl(reportRow);

  return {
    reportId,
    weekOf,
    version,
    isCorrection,
    propertyName,
    recipients,
    recipientOptions: options,
    subject: weeklyReportEmailSubject({ propertyName, weekOf }),
    greeting: weeklyReportGreeting(greetingNameFor(options, recipients)),
    contextParagraph,
    sender,
    attachPdf: true,
    shareUrl,
    bodyPreview: weeklyReportEmailBodyText({
      greetingName: greetingNameFor(options, recipients),
      contextParagraph,
      // The preview says what the sentence will look like even though the real token does not exist yet.
      // Showing the line with a placeholder beats hiding it and having the PM wonder where the link went.
      shareUrl: shareUrl ?? "(a link is generated when you send)",
      sender,
      isCorrection,
    }),
  };
}

/**
 * Validate what the PM posted back.
 *
 * Separate from the send so it can be exercised without a database — every rule here is one a client could
 * get wrong, and a 400 that names the field is the difference between a fixable mistake and a dead modal.
 */
export function normalizeWeeklyReportSendPayload(
  payload: WeeklyReportSendPayload,
  fallback: { subject: string; contextParagraph: string },
): { recipients: string[]; subject: string; contextParagraph: string; attachPdf: boolean } {
  if (!Array.isArray(payload?.recipients)) {
    throw new AppError(400, "recipients must be an array of email addresses");
  }
  // Rejects rather than silently drops. `normalizeWeeklyReportRecipients` discards anything unusable, so
  // comparing counts is what turns "you typed one of these wrong" into a message instead of an email that
  // quietly went to three people when the PM addressed it to four.
  const supplied = payload.recipients.filter((value) => typeof value === "string" && value.trim());
  const recipients = normalizeWeeklyReportRecipients(supplied);
  if (recipients.length === 0) {
    throw new AppError(400, "Add at least one recipient before sending");
  }
  const suppliedKeys = new Set(supplied.map((value) => String(value).trim().toLowerCase()));
  if (recipients.length !== suppliedKeys.size) {
    throw new AppError(400, "One or more recipients is not a valid email address");
  }
  if (recipients.length > WEEKLY_REPORT_SEND_LIMITS.maxRecipients) {
    throw new AppError(400, `A report can be sent to at most ${WEEKLY_REPORT_SEND_LIMITS.maxRecipients} recipients`);
  }

  const subject = text(payload.subject) ?? fallback.subject;
  if (subject.length > WEEKLY_REPORT_SEND_LIMITS.maxSubjectChars) {
    throw new AppError(400, `The subject is limited to ${WEEKLY_REPORT_SEND_LIMITS.maxSubjectChars} characters`);
  }

  // An explicitly EMPTY context paragraph is honoured — a PM who deletes it means it. Only an absent key
  // falls back to the composed default, which is what lets a client that does not offer the field at all
  // still send something sensible.
  const rawContext = payload.contextParagraph;
  const contextParagraph =
    rawContext === undefined || rawContext === null
      ? fallback.contextParagraph
      : typeof rawContext === "string"
        ? rawContext.trim()
        : (() => {
            throw new AppError(400, "The message must be text");
          })();
  if (contextParagraph.length > WEEKLY_REPORT_SEND_LIMITS.maxContextChars) {
    throw new AppError(400, `The message is limited to ${WEEKLY_REPORT_SEND_LIMITS.maxContextChars} characters`);
  }

  const attachPdf = payload.attachPdf === undefined ? true : payload.attachPdf === true;
  return { recipients, subject, contextParagraph, attachPdf };
}

export interface SendWeeklyReportInput {
  reportId: string;
  office: WeeklyReportSendOffice;
  actor: WeeklyReportActor;
  payload: WeeklyReportSendPayload;
  /**
   * Turns a freshly minted raw token into the client-facing URL. Injected rather than imported so the
   * service does not need an express Request — `weeklyReportShareUrl(req, token)` is the route's job.
   */
  shareUrlFor: (rawToken: string) => string;
}

/**
 * Send the report: `approved -> sent`, snapshot frozen, link minted, delivery queued.
 *
 * Everything below happens in the CALLER's transaction, which is what makes the outcome all-or-nothing: a
 * token minted for a report that never moved to `sent`, or a `sent` report with no queued delivery, are
 * both states nothing would ever reconcile.
 */
export async function sendWeeklyReport(
  client: QueryExecutor,
  input: SendWeeklyReportInput,
): Promise<{ report: WeeklyReportDetail; shareUrl: string; sendRequest: WeeklyReportSendRequest }> {
  const { reportRow, projectRow } = await loadSendTarget(client, input.reportId);
  if (!canPublishWeeklyReport(projectRow, input.actor)) {
    throw new AppError(403, "Only the assigned project manager can send this report to the client");
  }
  // Named before the generic ladder check so the PM is told what to do rather than merely refused. `sent`
  // is terminal for everyone, admin included — the client may already have opened the link.
  if (reportRow.status === "sent") {
    throw new AppError(409, "This report has already been sent — issue a correction instead");
  }
  if (!canTransitionWeeklyReport(reportRow.status, "sent")) {
    throw new AppError(409, "A report has to be approved by the PM before it can go to the client");
  }

  const weekOf = toIsoDate(reportRow.week_of)!;
  const version = Number(reportRow.version ?? 1);
  const isCorrection = version > 1;
  const propertyName = text(projectRow.property_display_name);
  const options = recipientOptionsFrom(projectRow);
  const sender = senderFrom(projectRow);

  const normalized = normalizeWeeklyReportSendPayload(input.payload, {
    subject: weeklyReportEmailSubject({ propertyName, weekOf }),
    contextParagraph: weeklyReportDefaultContextParagraph({ propertyName, weekOf, isCorrection }),
  });

  // MINTED SYNCHRONOUSLY, before the transition, so the response can hand the modal a real URL. It is also
  // the only moment the raw token exists: public.weekly_report_tokens stores a SHA-256 hash, so if this
  // value is not carried into the send request now it is unrecoverable and the email cannot link anywhere.
  const { rawToken } = await mintWeeklyReportToken(client, {
    weeklyReportId: input.reportId,
    tenantId: input.office.tenantId,
    officeSlug: input.office.slug,
    createdByUserId: input.actor.id,
  });
  const shareUrl = input.shareUrlFor(rawToken);

  const sendRequest: WeeklyReportSendRequest = {
    recipients: normalized.recipients,
    subject: normalized.subject,
    greetingName: greetingNameFor(options, normalized.recipients),
    contextParagraph: normalized.contextParagraph,
    shareUrl,
    sender,
    attachPdf: normalized.attachPdf,
    isCorrection,
    requestedBy: input.actor.id,
    requestedAt: new Date().toISOString(),
    requestVersion: 1,
  };
  const deliveryKey = crypto.randomUUID();

  // The transition itself — ladder, permissions, work-completed gate, the header snapshot, and a write
  // CONDITIONED ON the status it validated. The send request rides along in the same UPDATE so a report
  // can never be `sent` with nothing describing what was sent.
  const report = await transitionWeeklyReport(client, input.reportId, "sent", input.actor, {
    sendRequest: { request: sendRequest as unknown as Record<string, unknown>, deliveryKey },
  });

  if (isCorrection) {
    // Superseded HERE, at send, and not when the correction was cloned. Stamping it at clone time would
    // put "a newer version was issued" in front of a client the moment a PM started drafting a fix they
    // might never finish — pointing at a version that does not exist for them to read.
    //
    // Only rows that are not already superseded: v1 superseded by v2 keeps pointing at v2 when v3 goes
    // out. The banner does not name a version, and rewriting the pointer would lose the chain.
    await client.query(
      `UPDATE weekly_reports
          SET superseded_by_id = $1::uuid, updated_at = now()
        WHERE weekly_report_project_id = $2::uuid
          AND week_of = $3::date
          AND version < $4
          AND is_active
          AND superseded_by_id IS NULL`,
      [input.reportId, reportRow.weekly_report_project_id, weekOf, version],
    );
  }

  await enqueueWeeklyReportSendJob(client, {
    reportId: input.reportId,
    office: input.office,
    deliveryKey,
  });

  return { report, shareUrl, sendRequest };
}

/**
 * Queue the delivery, in the caller's transaction — a durable outbox.
 *
 * The payload is deliberately just the identity of the work. Everything the worker needs is on the report
 * row, so a job that sits in the queue across a deploy cannot deliver a stale copy of a request that has
 * since been retried with a different one. `deliveryKey` is the exception: it is carried so the worker can
 * tell a redelivery of THIS request from a job left over by an older one.
 */
async function enqueueWeeklyReportSendJob(
  client: QueryExecutor,
  input: { reportId: string; office: WeeklyReportSendOffice; deliveryKey: string },
): Promise<void> {
  await client.query(
    `INSERT INTO public.job_queue (job_type, payload, office_id, status, run_after)
     VALUES ($1, $2::jsonb, $3::uuid, 'pending', NOW())`,
    [
      WEEKLY_REPORT_SEND_JOB,
      JSON.stringify({
        reportId: input.reportId,
        officeSlug: input.office.slug,
        tenantSchema: `office_${input.office.slug}`,
        deliveryKey: input.deliveryKey,
      }),
      input.office.tenantId,
    ],
  );
}

/**
 * Queue the delivery again for a send that has not reached the client.
 *
 * Replays the STORED request unchanged, with the SAME delivery key. Rotating the key would make this a
 * genuinely new message to the provider — and a "failed" job is not proof nothing was sent: the provider
 * can accept a message and the process die before `send_delivered_at` is stamped, which is precisely the
 * case a retry exists for. Reusing the key means the worst outcome is a no-op, not a client receiving
 * their report twice.
 *
 * A PM who needs to reach DIFFERENT people issues a correction; that is a new report row with its own key
 * and its own link, which is also the only honest way to tell the client something changed.
 */
export async function retryWeeklyReportSend(
  client: QueryExecutor,
  reportId: string,
  actor: WeeklyReportActor,
  office: WeeklyReportSendOffice,
): Promise<WeeklyReportDetail> {
  const { reportRow, projectRow } = await loadSendTarget(client, reportId);
  if (!canPublishWeeklyReport(projectRow, actor)) {
    throw new AppError(403, "Only the assigned project manager can retry a send");
  }
  if (reportRow.status !== "sent") {
    throw new AppError(409, "Only a report that has been sent can have its delivery retried");
  }
  if (reportRow.send_delivered_at) {
    throw new AppError(409, "This report has already reached the client");
  }
  const deliveryKey = text(reportRow.send_delivery_key);
  if (!reportRow.send_request || !deliveryKey) {
    // Reachable only for a report moved to `sent` by something other than this flow. Refusing beats
    // inventing a request: nobody can say what that email was supposed to contain.
    throw new AppError(409, "There is no send on this report to retry");
  }

  // Clear the error but NOT send_attempts. The count is the record of how much trouble this delivery has
  // been; zeroing it on every retry would hide a report that has failed nine times behind a chip that
  // always reads "attempt 1".
  await client.query(
    `UPDATE weekly_reports SET send_error = NULL, updated_at = now()
      WHERE id = $1::uuid AND is_active AND status = 'sent' AND send_delivered_at IS NULL`,
    [reportId],
  );
  await enqueueWeeklyReportSendJob(client, { reportId, office, deliveryKey });

  const updated = await getWeeklyReportDetail(client, reportId);
  if (!updated) throw new AppError(404, "Weekly report not found");
  return updated;
}

/**
 * Clone a SENT report to `version + 1` so it can be corrected and re-issued.
 *
 * The clone lands in `approved`, carrying the `submitted_*` and `reviewed_*` stamps that walking it up the
 * ladder would have produced, so the audit trail reads the same as any other report rather than showing a
 * report that reached `approved` without ever being submitted. That mirrors the documented handling of a
 * PM authoring from scratch, and it is right here for the same reason: the person issuing a correction IS
 * the reviewer, and making them submit a report to themselves adds a step without adding a check. They can
 * still edit it before sending — an `approved` report is editable by PM powers.
 *
 * The ORIGINAL is untouched. Its link keeps resolving and only starts showing the superseded banner when
 * the correction is actually sent (see sendWeeklyReport).
 */
export async function createWeeklyReportCorrection(
  client: QueryExecutor,
  reportId: string,
  actor: WeeklyReportActor,
): Promise<WeeklyReportDetail> {
  const { reportRow, projectRow } = await loadSendTarget(client, reportId);
  if (!canPublishWeeklyReport(projectRow, actor)) {
    throw new AppError(403, "Only the assigned project manager can issue a correction");
  }
  if (reportRow.status !== "sent") {
    throw new AppError(409, "Only a report that has been sent needs a correction — edit it instead");
  }

  const weekOf = toIsoDate(reportRow.week_of)!;
  // The highest version for this week, taken under the report lock we already hold on the source row.
  // MAX rather than `source.version + 1`: correcting v1 twice would otherwise collide with the live v2 on
  // weekly_reports_project_week_version_uidx and surface as a raw 23505.
  const latest = await client.query(
    `SELECT COALESCE(MAX(version), 0) AS version
       FROM weekly_reports
      WHERE weekly_report_project_id = $1::uuid AND week_of = $2::date AND is_active`,
    [reportRow.weekly_report_project_id, weekOf],
  );
  const nextVersion = Number(latest.rows[0]?.version ?? 0) + 1;

  const inserted = await client.query(
    `INSERT INTO weekly_reports (
       client_submission_id, weekly_report_project_id, deal_id, week_of, version, status,
       work_completed, next_week_look_ahead, issues_concerns,
       completion_percent, weather_delay_days, remaining_weeks, projected_duration_weeks,
       authored_by, authored_at, submitted_by, submitted_at, reviewed_by, reviewed_at
     )
     SELECT $1::uuid, wr.weekly_report_project_id, wr.deal_id, wr.week_of, $2, 'approved',
            wr.work_completed, wr.next_week_look_ahead, wr.issues_concerns,
            wr.completion_percent, wr.weather_delay_days, wr.remaining_weeks, wr.projected_duration_weeks,
            $3::uuid, now(), $3::uuid, now(), $3::uuid, now()
       FROM weekly_reports wr
      WHERE wr.id = $4::uuid AND wr.is_active
     RETURNING id`,
    [crypto.randomUUID(), nextVersion, actor.id, reportId],
  );
  const correctionId = inserted.rows[0]?.id;
  if (!correctionId) throw new AppError(409, "The report changed while the correction was being created");

  // Photos come across with their REPORT captions, not the files' descriptions — the correction starts as
  // a copy of what the client saw, which is the only sensible starting point for fixing it.
  await client.query(
    `INSERT INTO weekly_report_photos (weekly_report_id, file_id, caption, sort_order)
     SELECT $1::uuid, file_id, caption, sort_order
       FROM weekly_report_photos
      WHERE weekly_report_id = $2::uuid`,
    [correctionId, reportId],
  );

  const detail = await getWeeklyReportDetail(client, correctionId);
  if (!detail) throw new AppError(500, "The correction could not be read back after creation");
  return detail;
}
