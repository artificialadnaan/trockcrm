import crypto from "node:crypto";
import {
  WEEKLY_REPORT_PROVIDER_IDEMPOTENCY_WINDOW_HOURS,
  WEEKLY_REPORT_SEND_LIMITS,
  normalizeWeeklyReportRecipients,
  sanitizeWeeklyReportSubject,
  weeklyReportDefaultContextParagraph,
  weeklyReportEmailBodyText,
  weeklyReportEmailSubject,
  weeklyReportGreeting,
  weeklyReportGreetingNameFor,
  weeklyReportRetryIsProviderDeduped,
  type WeeklyReportRecipientOption,
  type WeeklyReportSenderContact,
  type WeeklyReportSendRequest,
} from "@trock-crm/shared/lib/weeklyReportEmail";
import {
  WEEKLY_REPORT_DELIVERY_FAILURE_STATUSES,
  weeklyReportDeliveryFailed,
  weeklyReportDeliveryLabel,
  isWeeklyReportDeliveryStatus,
} from "@trock-crm/shared/lib/weeklyReportDelivery";
import { canTransitionWeeklyReport } from "@trock-crm/shared/types";
import { AppError } from "../../middleware/error-handler.js";
import { registerWeeklyReportSendDelivery } from "./delivery-service.js";
import {
  WEEKLY_REPORT_CLIENT_ROLES,
  trockTeamColumns,
  trockTeamJoins,
  type QueryExecutor,
} from "./projects-service.js";
import {
  canPublishWeeklyReport,
  getWeeklyReportDetail,
  transitionWeeklyReport,
  type WeeklyReportActor,
  type WeeklyReportDetail,
} from "./reports-service.js";
import { isWeeklyReportShareableStatus, mintWeeklyReportToken } from "./tokens-service.js";

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
  /**
   * True only when an earlier version of this week ACTUALLY REACHED the client — the same predicate the
   * email uses, so the modal's "this replaces the copy they already have" banner and the sentence the
   * client reads can never disagree. A v2 whose v1 never got out is not a correction; it is a first copy.
   */
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

/**
 * Frozen onto the report row, and the ONLY thing the worker reads when it builds the message.
 *
 * Declared in `shared` and re-exported here: the worker reads this object out of jsonb, and while it was a
 * server-local interface the worker's suite could only assert it against a fixture it wrote itself.
 */
export type { WeeklyReportSendRequest } from "@trock-crm/shared/lib/weeklyReportEmail";

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
    // `phone` stays on the LOGIN: the field-team roster carries a name and an email and no number, so
    // there is nothing to coalesce it with.
    `SELECT wrp.*,
${trockTeamColumns()},
            pm_u.phone AS trock_pm_phone
       FROM weekly_report_projects wrp
${trockTeamJoins("wrp")}
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
 * Has an EARLIER version of this week's report actually reached the client?
 *
 * This — not `version > 1` — is what makes a send a correction. Two very different situations produce a
 * v2: the content was wrong, or the v1 email never got out. Only the first replaces something. Telling a
 * client that this version "replaces the previous copy" when no previous copy ever arrived sends them
 * hunting for an email that does not exist, and it is the second situation that is common, because a PM
 * looking at a "Send failed" chip reaches for the most prominent button on the row.
 *
 * TWO FACTS, READ TOGETHER. `send_delivered_at` records that the mail provider ACCEPTED the message, which
 * is all the send path can ever observe; `send_delivery_status` records what the provider said afterwards
 * on its delivery webhook (0227). Acceptance alone used to be the whole answer here, and it was wrong in
 * the one direction that matters: a v1 accepted and then HARD-BOUNCED reads as delivered, so the v2 that
 * follows tells the client it "replaces the previous copy" of an email that never arrived — sending them
 * to search a mailbox for something that is not in it. A bounced or never-sent version did not reach
 * anybody, so it cannot be what a correction corrects.
 *
 * `complained` is deliberately NOT excluded: a spam complaint can only follow a delivery, so that client
 * does have the report and the replacement wording is correct for them.
 */
async function priorVersionReachedClient(
  client: QueryExecutor,
  input: { weeklyReportProjectId: string; weekOf: string; version: number },
): Promise<boolean> {
  const result = await client.query(
    `SELECT 1
       FROM weekly_reports
      WHERE weekly_report_project_id = $1::uuid
        AND week_of = $2::date
        AND version < $3
        AND is_active
        AND status = 'sent'
        AND send_delivered_at IS NOT NULL
        AND (send_delivery_status IS NULL OR NOT (send_delivery_status = ANY($4::text[])))
      LIMIT 1`,
    [
      input.weeklyReportProjectId,
      input.weekOf,
      input.version,
      // Bound from the shared vocabulary rather than spelled out here, so adding a verdict that means
      // "the client did not get it" cannot leave this predicate quietly behind.
      [...WEEKLY_REPORT_DELIVERY_FAILURE_STATUSES],
    ],
  );
  return Boolean(result.rows[0]);
}

/**
 * Compose the send modal, server-side.
 *
 * Readable by anyone who may publish the report (the assigned PM or leadership) — the same gate the send
 * itself takes, because the draft exposes the client's contact addresses and the PM's phone number.
 *
 * IT DOES NOT RETURN A SHARE URL, for a sent report or any other. An earlier revision read the raw link
 * back off `send_request.shareUrl` so the modal could re-show it, which made every sent report's live
 * 180-day client link readable through the API by anyone who can open the modal — and made "This link is
 * shown once" false. The token table stores only a hash precisely so that a database read cannot
 * reconstruct a live link; a jsonb column that keeps the raw URL forever hands that property straight
 * back. The link is returned exactly once, in the response to the send itself; a PM who needs another
 * mints one from the share-link route, which is auditable.
 */
export async function buildWeeklyReportSendDraft(
  client: QueryExecutor,
  reportId: string,
  actor: WeeklyReportActor,
): Promise<WeeklyReportSendDraft> {
  const { reportRow, projectRow } = await loadSendTarget(client, reportId);
  if (!canPublishWeeklyReport(projectRow, actor)) {
    throw new AppError(403, "Only the assigned project manager or office leadership can send this report to the client");
  }

  const weekOf = toIsoDate(reportRow.week_of)!;
  const version = Number(reportRow.version ?? 1);
  const isCorrection = await priorVersionReachedClient(client, {
    weeklyReportProjectId: reportRow.weekly_report_project_id,
    weekOf,
    version,
  });
  const propertyName = text(projectRow.property_display_name);
  const options = recipientOptionsFrom(projectRow);
  const recipients = options.map((option) => option.email);
  const sender = senderFrom(projectRow);
  const contextParagraph = weeklyReportDefaultContextParagraph({ propertyName, weekOf, isCorrection });

  return {
    reportId,
    weekOf,
    version,
    isCorrection,
    propertyName,
    recipients,
    recipientOptions: options,
    subject: weeklyReportEmailSubject({ propertyName, weekOf }),
    greeting: weeklyReportGreeting(weeklyReportGreetingNameFor(options, recipients)),
    contextParagraph,
    sender,
    attachPdf: true,
    bodyPreview: weeklyReportEmailBodyText({
      greetingName: weeklyReportGreetingNameFor(options, recipients),
      contextParagraph,
      // The preview says what the sentence will look like even though the real token does not exist yet.
      // Showing the line with a placeholder beats hiding it and having the PM wonder where the link went.
      shareUrl: "(a link is generated when you send)",
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

  // Sanitised BEFORE the length check, and before it can reach a provider: this string is handed to
  // `resend.emails.send({ subject })` verbatim, and a CR or LF inside a header value is the classic
  // header-injection shape. Collapsing whitespace also stops a pasted multi-line subject arriving as a
  // subject the client's mail client renders in pieces.
  const suppliedSubject = text(payload.subject);
  const subject = suppliedSubject ? sanitizeWeeklyReportSubject(suppliedSubject) : fallback.subject;
  if (!subject) {
    throw new AppError(400, "The subject cannot be blank");
  }
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
    throw new AppError(403, "Only the assigned project manager or office leadership can send this report to the client");
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
  const isCorrection = await priorVersionReachedClient(client, {
    weeklyReportProjectId: reportRow.weekly_report_project_id,
    weekOf,
    version,
  });
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
    greetingName: weeklyReportGreetingNameFor(options, normalized.recipients),
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

  if (version > 1) {
    // Superseded HERE, at send, and not when the correction was cloned. Stamping it at clone time would
    // put "a newer version was issued" in front of a client the moment a PM started drafting a fix they
    // might never finish — pointing at a version that does not exist for them to read.
    //
    // Four predicates, each load-bearing:
    //   `version < $4`          — strictly earlier. `<=` would make this version supersede ITSELF, which
    //                             the dashboard reads as "no live report for this week".
    //   `superseded_by_id IS NULL` — v1 superseded by v2 keeps pointing at v2 when v3 goes out. The
    //                             banner does not name a version, and rewriting the pointer loses the chain.
    //   `status = 'sent'`       — only a version the CLIENT WAS SENT can be superseded. An unsent draft
    //                             stamped here would show the "a newer version was issued" notice on a
    //                             link the client opens from the email that just arrived, for a version
    //                             they were never sent, and nothing ever clears the stamp.
    //   `is_active`             — a discarded report is not part of the chain.
    //
    // Keyed on `version > 1` rather than on `isCorrection`: a v2 whose v1 never reached the client is not
    // a correction (the email says so), but v1 is still the older row of the same week and must stop
    // being the live one.
    await client.query(
      `UPDATE weekly_reports
          SET superseded_by_id = $1::uuid, updated_at = now()
        WHERE weekly_report_project_id = $2::uuid
          AND week_of = $3::date
          AND version < $4
          AND is_active
          AND status = 'sent'
          AND superseded_by_id IS NULL`,
      [input.reportId, reportRow.weekly_report_project_id, weekOf, version],
    );
  }

  // The delivery key's office, registered in `public` — the one thing that lets a bounce find its way home.
  //
  // In the CALLER's transaction with everything else, and that matters more than it looks. The delivery
  // webhook is unauthenticated and arrives with no office context at all; this row is what turns a key into
  // a schema. A `sent` report with no row here is a report whose bounce resolves to nothing and is dropped
  // silently — the exact failure the webhook exists to end — so it must not be possible for the transition
  // to commit without it.
  await registerWeeklyReportSendDelivery(client, {
    deliveryKey,
    weeklyReportId: input.reportId,
    tenantId: input.office.tenantId,
    officeSlug: input.office.slug,
  });

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
 * Mint a FRESH client link for a report that already has one.
 *
 * #17: a field PM sends from the phone, is shown the link once, leaves the screen, and cannot get it back.
 * The raw token is returned exactly once and only its SHA-256 hash is stored, so nothing can hand the old
 * value back — re-minting is the only route to a usable link. That route existed, on the CRM router behind
 * its admin/director/rep gate, which a `construction` PM cannot reach. The result was a PM asking a
 * director for a link to a report they wrote and sent themselves.
 *
 * THE GATE IS `canPublishWeeklyReport`, THE SAME ONE SENDING USES, and that is the point of putting this in
 * the service rather than in each router. A share link is a durable, login-free credential to a client
 * document for 180 days; whoever may mint one has to be whoever may publish one. Deriving it here means the
 * phone and the CRM cannot drift into two different answers about who that is — the CRM route now calls
 * this too, so the rule has one home.
 *
 * A NEW TOKEN, never the existing one. The rule `mintWeeklyReportToken` already documents: revoking the
 * link you just emailed must not kill the one a client is already reading. Both stay valid, and the view
 * log is keyed on `weekly_report_id` rather than on the token, so a second link does not fragment the
 * audit that answers "did they open it".
 */
export async function remintWeeklyReportShareLink(
  client: QueryExecutor,
  reportId: string,
  actor: WeeklyReportActor,
  office: WeeklyReportSendOffice,
  shareUrlFor: (rawToken: string) => string,
): Promise<{ url: string; token: Record<string, unknown> }> {
  const { reportRow, projectRow } = await loadSendTarget(client, reportId);
  if (!canPublishWeeklyReport(projectRow, actor)) {
    throw new AppError(403, "Only the assigned project manager can create a client link for this report");
  }
  // Re-checked here rather than trusted from the caller: `approved` is not terminal, so a report can be
  // pulled back and rewritten between one mint and the next.
  if (!isWeeklyReportShareableStatus(reportRow.status)) {
    throw new AppError(409, "A client link can only be created once the PM has approved the report");
  }
  const { rawToken, token } = await mintWeeklyReportToken(client, {
    weeklyReportId: reportId,
    tenantId: office.tenantId,
    officeSlug: office.slug,
    createdByUserId: actor.id,
  });
  return { url: shareUrlFor(rawToken), token: token as unknown as Record<string, unknown> };
}

/**
 * Queue the delivery again for a send that has not reached the client.
 *
 * Replays the STORED request unchanged, with the SAME delivery key. Rotating the key would make this a
 * genuinely new message to the provider — and a "failed" job is not proof nothing was sent: the provider
 * can accept a message and the process die before `send_delivered_at` is stamped, which is precisely the
 * case a retry exists for.
 *
 * THE KEY ONLY DEDUPES FOR 24 HOURS. Resend keeps an idempotency key for a day; the "Send failed" chip
 * lives on the board for the 26-week lookback. So the guarantee that "the worst outcome is a no-op" holds
 * INSIDE the window and not outside it, and a PM clicking Retry the following Monday would be sending a
 * genuinely second copy while the UI told them it was safe. Past the window the retry is still available —
 * an undelivered client report has to have a way forward — but it is a DELIBERATE act: the caller must
 * pass `acknowledgeDuplicateRisk`, which the CRM only sets after saying plainly what it risks.
 *
 * A PM who needs to reach DIFFERENT people issues a correction; that is a new report row with its own key
 * and its own link, which is also the only honest way to tell the client something changed.
 */
export async function retryWeeklyReportSend(
  client: QueryExecutor,
  reportId: string,
  actor: WeeklyReportActor,
  office: WeeklyReportSendOffice,
  options: { acknowledgeDuplicateRisk?: boolean; now?: Date } = {},
): Promise<WeeklyReportDetail> {
  const { reportRow, projectRow } = await loadSendTarget(client, reportId);
  if (!canPublishWeeklyReport(projectRow, actor)) {
    throw new AppError(403, "Only the assigned project manager or office leadership can retry a send");
  }
  if (reportRow.status !== "sent") {
    throw new AppError(409, "Only a report that has been sent can have its delivery retried");
  }
  // A SUPERSEDED VERSION IS NEVER RETRIED, AND THIS IS THE LAYER THAT HAS TO SAY SO.
  //
  // Checked before the delivery and window gates because it is the only refusal that is true of a report
  // whose email must never go out AT ALL, and because the "issue a correction instead" wording of those
  // two would be actively wrong here: a correction already exists and has already been sent.
  //
  // The state is ordinary, not exotic. v1 is sent Monday and its delivery fails; the PM issues a
  // correction; v2 is sent and delivered Tuesday. v1 is then `sent`, `superseded_by_id` = v2,
  // `send_delivered_at` still NULL — every predicate the retry path checks is satisfied — and its
  // `send_request` still carries the live share URL, which is only dropped on delivery. Replaying it
  // emails a paying client the version they were told was replaced, with `isCorrection: false` so the
  // message itself says nothing about it, pointing at a page that then shows them a superseded notice.
  // Irreversible, and no dashboard reports it: the board's undelivered query already carries
  // `superseded_by_id IS NULL`, so it is silent on this row by construction.
  //
  // Stated here rather than only on the button because the CRM is not the only way in — the deferred
  // field mount reuses this service unchanged, and the worker refuses the same state independently.
  if (reportRow.superseded_by_id) {
    throw new AppError(
      409,
      "A newer version of this report has already been sent to the client, so this one must not go out " +
        "again — retry the delivery on the newest version instead",
    );
  }
  if (reportRow.send_delivered_at) {
    // Worded as what the platform can actually evidence, which is now two different things.
    //
    // `send_delivered_at` records that the MAIL PROVIDER ACCEPTED the message, and on its own that is all
    // it has ever meant — "This report has already reached the client" was a claim nothing here could
    // support. Since 0227 the provider's delivery webhook may have said more, and when it has said the
    // message BOUNCED the bare acceptance wording is actively misleading: it points a PM at a correction
    // as though the client merely needs a newer copy, when what they actually need is a different address.
    //
    // The refusal itself does not change, and that is deliberate. A retry replays the SAME message to the
    // SAME recipients under the same idempotency key; inside the provider's window it is a no-op, and
    // outside it, it bounces again off the same bad address. A correction is the only route that can reach
    // anybody, because it is the only one that can be addressed differently.
    const verdict = isWeeklyReportDeliveryStatus(reportRow.send_delivery_status)
      ? reportRow.send_delivery_status
      : null;
    if (verdict && weeklyReportDeliveryFailed(verdict)) {
      const detail = (reportRow.send_delivery_detail ?? null) as { bounceClass?: unknown } | null;
      const label = weeklyReportDeliveryLabel(
        verdict,
        typeof detail?.bounceClass === "string"
          ? (detail.bounceClass as "hard" | "soft" | "unknown")
          : null,
      );
      throw new AppError(
        409,
        `The mail provider accepted this report and then reported it as not delivered (${label}). ` +
          "Re-sending would repeat the same message to the same address — check the client's email " +
          "address on the project and issue a correction to send it again.",
      );
    }
    throw new AppError(
      409,
      "This report's email was already accepted by the mail provider — issue a correction to send it again",
    );
  }
  if (
    !options.acknowledgeDuplicateRisk &&
    !weeklyReportRetryIsProviderDeduped(reportRow.sent_at, options.now)
  ) {
    throw new AppError(
      409,
      `This send is more than ${WEEKLY_REPORT_PROVIDER_IDEMPOTENCY_WINDOW_HOURS} hours old, so the mail ` +
        "provider will no longer recognise it as a duplicate. Retrying now can put a second copy in the " +
        "client's inbox — confirm that you want to send it again.",
    );
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
  //
  // AND MOVE THE CLOCK. `send_last_attempt_at` is what the board ages a stall against (see
  // `lastSendActivityAt` in dashboard-service.ts); `sent_at` is stamped once at commit and never moves.
  // Writing nothing here meant the retry cleared the error and left the row measurably ninety minutes
  // old, so the chip flipped straight from "Send failed · 3 attempts" to "Send stuck" — the PM's click
  // produced no positive signal at all, and past the provider's dedupe window a PM who acknowledged the
  // duplicate risk, saw the row unchanged and clicked again put a second real copy in the client's inbox.
  // With the stamp the row reads "Sending…" and offers no second Retry until the threshold passes again.
  //
  // It is honest to write it here: the column records when this delivery was last attempted, and handing
  // it to the queue is the start of an attempt. The worker overwrites it when that attempt finishes.
  //
  // AND RE-ARM THE ALERT. `send_stall_alerted_at` (0227) is the worker sweep's memory of having already
  // told leadership this delivery stopped moving, and it is what stops the sweep emailing about the same
  // report every fifteen minutes. A retry is a transition OUT of stalled: somebody saw the alert and
  // acted, so if this attempt also goes quiet that is a NEW incident and the people who acted on the first
  // one are exactly the people who need to hear it. Left set, a report retried three times and stalled
  // three times would be announced once and then never again.
  //
  // Cleared HERE and not in the worker's own attempt bookkeeping on purpose. The queue's three automatic
  // retries all land inside 40 seconds (3s/9s/27s backoff), far inside the stall threshold, so clearing
  // there would re-arm the alert for a failure nobody has touched — which is the mute-inducing repeat this
  // column exists to prevent. Only a human pressing Retry clears it.
  await client.query(
    `UPDATE weekly_reports
        SET send_error = NULL, send_last_attempt_at = now(), send_stall_alerted_at = NULL, updated_at = now()
      WHERE id = $1::uuid AND is_active AND status = 'sent' AND send_delivered_at IS NULL`,
    [reportId],
  );
  // REGISTERED HERE TOO, and not only in `sendWeeklyReport`. The worker tags EVERY message it hands the
  // provider with this key, replays included, so a retry that skipped this put a delivery key on a real
  // client email that nothing could resolve — its bounce arrives, finds no office, and is dropped.
  //
  // Two ways to reach that, neither exotic. Every send committed before this feature deployed has no row
  // in the map at all, and those are EXACTLY the rows the board draws a Retry button beside (the retry
  // population is `status = 'sent' AND send_delivered_at IS NULL`), so on the first day the action the
  // product recommends is the action that loses the verdict. And permanently, because the API and the
  // worker are separate Railway services: a send committed by the old API while the new worker is live
  // gets a tagged message and no map row.
  //
  // ON CONFLICT DO NOTHING makes the ordinary case — the row `sendWeeklyReport` already wrote — free, so
  // this is a repair for the rows that need one rather than a second source of truth.
  await registerWeeklyReportSendDelivery(client, {
    deliveryKey,
    weeklyReportId: reportId,
    tenantId: office.tenantId,
    officeSlug: office.slug,
  });
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
    throw new AppError(403, "Only the assigned project manager or office leadership can issue a correction");
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
  const latestVersion = Number(latest.rows[0]?.version ?? 0);
  const sourceVersion = Number(reportRow.version ?? 1);

  // REFUSED when a newer version already exists, which is the difference between one correction and a
  // pile of them. History offers "Send correction" on any sent row that is not yet superseded, and a row
  // is only superseded when its replacement is SENT — so a PM who drafts a v2 and comes back to the same
  // v1 row is offered the button again and gets a v3. Both land `approved`, sending v2 supersedes only v1,
  // and the week is then left live on v3: the board says the client is still owed a report they have
  // already received, its Send button targets a THIRD email, and a delivery failure on v2 shows no chip
  // because the live row is v3.
  //
  // Refusing names the version to work on instead, which is what the PM actually wants.
  if (latestVersion > sourceVersion) {
    throw new AppError(
      409,
      `Version ${latestVersion} of this week's report already exists — finish and send that one instead ` +
        "of starting another correction",
    );
  }
  const nextVersion = latestVersion + 1;

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
