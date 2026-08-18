import { Router, type Request } from "express";
import { businessToday } from "../../lib/period.js";
import { AppError } from "../../middleware/error-handler.js";
import { requireRole } from "../../middleware/rbac.js";
import {
  createWeeklyReportProject,
  deactivateWeeklyReportProject,
  getWeeklyReportProject,
  getWeeklyReportProjectRow,
  getWeeklyReportSettings,
  listWeeklyReportAssignableUsers,
  listWeeklyReportProjects,
  updateWeeklyReportProject,
  updateWeeklyReportSettings,
} from "./projects-service.js";
import {
  canPublishWeeklyReport,
  createWeeklyReportDraft,
  getWeeklyReportDetail,
  listWeeklyReportPhotoCandidates,
  listWeeklyReports,
  replaceWeeklyReportPhotos,
  transitionWeeklyReport,
  updateWeeklyReportContent,
  type WeeklyReportActor,
} from "./reports-service.js";
import {
  dismissWeeklyReportWeek,
  getWeeklyReportDashboard,
  listWeeklyReportProjectSummaries,
} from "./dashboard-service.js";
import {
  loadWeeklyReportPdfSource,
  resolveArtifactKey,
  weeklyReportPdfDownloadUrl,
  weeklyReportPdfFilename,
} from "./pdf-service.js";
import {
  isWeeklyReportShareableStatus,
  listWeeklyReportTokens,
  mintWeeklyReportToken,
  revokeWeeklyReportToken,
  weeklyReportShareUrl,
} from "./tokens-service.js";
import {
  buildWeeklyReportSendDraft,
  createWeeklyReportCorrection,
  retryWeeklyReportSend,
  sendWeeklyReport,
} from "./send-service.js";
import { isIsoDateString } from "@trock-crm/shared/types";

const router = Router();
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * The whole router is CRM-STAFF ONLY — not merely "a CRM user".
 *
 * `requireCrmUser` on the tenant mount admits `construction`, which is how superintendents reach the
 * CRM at all. Without this line every superintendent could read the office-wide leadership board, every
 * project's client contact details and the digest recipients, and could edit or deactivate any setup
 * and dismiss arbitrary weeks — i.e. delete the record of their own missed reports.
 *
 * The allow-list matches the client route guard on /projects/weekly-reports exactly, so the two cannot
 * drift into a UI that hides a page the API still serves. A superintendent's surface is T-Rock Cam via
 * /api/field, which is a separate mount with its own authorisation.
 */
router.use(requireRole("admin", "director", "rep"));

// THE SHARE-LINK ROUTES BELONG BEHIND THIS GATE TOO, AND A PREVIOUS REVISION HOISTED THEM AHEAD OF IT.
//
// The intent was to let an assigned PM on a `construction` role mint and revoke their own client link —
// `ASSIGNABLE_ROLES` includes `construction` and `field_contractor`, which is what a real PM usually is.
// Hoisting delivered none of that: `GET /reports/:id` and `POST /reports/:id/transition` stayed behind
// the gate, and the client gates /projects/weekly-reports on the same three roles, so a construction PM
// has no way to obtain a report id to pass in. What it DID deliver was every construction and
// field_contractor user in the office reaching all three endpoints, each of which reveals its refusal
// only after `loadPublishableReport` has taken FOR UPDATE on two rows.
//
// The assigned PM's publication action belongs on the FIELD router (/api/field/weekly-reports), where
// that PM actually works and where their app already authenticates. Deliberately deferred to the
// send-flow PR rather than half-built here.

function requireUuid(value: unknown, label: string): string {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
    throw new AppError(400, `${label} must be a valid UUID`);
  }
  return value;
}

function actorFrom(req: Request): WeeklyReportActor {
  if (!req.user?.id) throw new AppError(401, "Authentication required");
  return { id: req.user.id, role: String(req.user.role ?? "") };
}

/** The office the request is scoped to — the roster any assignee must belong to. */
function officeIdFrom(req: Request): string {
  const officeId = req.user?.activeOfficeId;
  if (!officeId) throw new AppError(400, "Office context not available");
  return officeId;
}

/**
 * "Today" in the OFFICE's timezone, not the browser's.
 *
 * A director in Karachi opening the page at 09:00 local is looking at a Dallas jobsite where it is still
 * yesterday afternoon; anchoring on their clock would mark a report late a day early. `asOf` is
 * overridable for tests and for looking at a past week, but only as a real date.
 */
function asOfFrom(req: Request): string {
  const supplied = req.query.asOf;
  if (typeof supplied === "string" && supplied.trim()) {
    if (!isIsoDateString(supplied.trim())) {
      throw new AppError(400, "asOf must be a YYYY-MM-DD date");
    }
    return supplied.trim();
  }
  return businessToday();
}

function readQueryString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/**
 * Refuse to mint a client link when nothing says where client links live.
 *
 * FAILS CLOSED IN PRODUCTION, warns elsewhere. The deploy is configured today
 * (reports.trockcam.com), so this is fragility rather than a live bug — but the cost of being wrong is a
 * client receiving an email whose only link 404s, discoverable by nobody but them, and the send is
 * irreversible the moment the transaction commits. A local or CI process legitimately has no such host,
 * so the refusal is scoped to the environment where a real client is on the other end.
 */
function assertClientLinksAreConfigured(): void {
  if (process.env.PUBLIC_SHARE_BASE_URL?.trim()) return;
  if (process.env.NODE_ENV === "production") {
    throw new AppError(
      500,
      "Client links are not configured (PUBLIC_SHARE_BASE_URL is unset), so the link in the client's " +
        "email would not resolve. Nothing has been sent.",
    );
  }
  console.warn(
    "[weekly-report] PUBLIC_SHARE_BASE_URL is unset — a client link would be minted against FRONTEND_URL " +
      "or the request host, neither of which is guaranteed to serve /wr.",
  );
}

/**
 * Who may rewrite the addresses the send modal pre-fills.
 *
 * `client_doc_email` and its three siblings are not ordinary setup fields: `recipientOptionsFrom` turns
 * them into `draft.recipients`, PRE-SELECTED in the send dialog. The project routes are open to every
 * `rep` in the office, so without this any of them could typo-squat a client address on any project and
 * wait — the next director to press Send delivers that client's report, the PDF and a live 180-day
 * unauthenticated link to the attacker's mailbox, with the CRM showing a perfectly ordinary send.
 *
 * The same shape is already guarded one field over: `assertAssignableUser` re-validates assignees on every
 * patch precisely because the route admits `rep`. This is the other end of the same problem, and it became
 * one the moment these columns turned into an email sink.
 */
function assertMayEditClientContacts(req: Request, body: unknown): void {
  const clientTeam = (body as { clientTeam?: unknown } | null | undefined)?.clientTeam;
  if (clientTeam == null) return;
  const role = String(req.user?.role ?? "");
  if (role === "admin" || role === "director") return;
  throw new AppError(403, "Only an admin or director can change a project's client contacts");
}

// ---------------------------------------------------------------------------
// Dashboard
// ---------------------------------------------------------------------------

router.get("/dashboard", async (req, res, next) => {
  try {
    const lookbackRaw = readQueryString(req.query.lookbackWeeks);
    const data = await getWeeklyReportDashboard(req.tenantClient!, {
      asOf: asOfFrom(req),
      lookbackWeeks: lookbackRaw ? Number(lookbackRaw) : undefined,
    });
    await req.commitTransaction!();
    res.json(data);
  } catch (error) {
    next(error);
  }
});

// ---------------------------------------------------------------------------
// Projects (setup)
// ---------------------------------------------------------------------------

router.get("/projects", async (req, res, next) => {
  try {
    const asOf = asOfFrom(req);
    const [projects, summaries] = await Promise.all([
      listWeeklyReportProjects(req.tenantClient!, {
        status: readQueryString(req.query.status),
        search: readQueryString(req.query.search),
      }),
      listWeeklyReportProjectSummaries(req.tenantClient!, asOf),
    ]);
    const summaryById = new Map(summaries.map((s) => [s.weeklyReportProjectId, s]));
    await req.commitTransaction!();
    res.json({
      asOf,
      projects: projects.map((project) => ({
        ...project,
        summary: summaryById.get(project.id) ?? null,
      })),
    });
  } catch (error) {
    next(error);
  }
});

/**
 * The PM / superintendent picker feed. Any CRM user may read it — a PM setting up their own project
 * cannot be sent through the admin-only `/admin/field-users` route.
 */
router.get("/assignable-users", async (req, res, next) => {
  try {
    const users = await listWeeklyReportAssignableUsers(req.tenantClient!, officeIdFrom(req));
    await req.commitTransaction!();
    res.json({ users });
  } catch (error) {
    next(error);
  }
});

router.post("/projects", async (req, res, next) => {
  try {
    assertMayEditClientContacts(req, req.body);
    const actor = actorFrom(req);
    const project = await createWeeklyReportProject(
      req.tenantClient!,
      { ...req.body, dealId: requireUuid(req.body?.dealId, "dealId") },
      actor.id,
      officeIdFrom(req),
    );
    await req.commitTransaction!();
    res.status(201).json(project);
  } catch (error) {
    next(error);
  }
});

router.get("/projects/:id", async (req, res, next) => {
  try {
    const project = await getWeeklyReportProject(req.tenantClient!, requireUuid(req.params.id, "id"));
    if (!project) throw new AppError(404, "Weekly report project not found");
    await req.commitTransaction!();
    res.json(project);
  } catch (error) {
    next(error);
  }
});

router.patch("/projects/:id", async (req, res, next) => {
  try {
    assertMayEditClientContacts(req, req.body);
    // No `asOf` here on purpose: pausing and resuming are recorded on the day they happen. Letting the
    // query string date a WRITE would let a caller backdate a pause over weeks that were genuinely
    // missed and clear them off the board without a dismissal.
    const project = await updateWeeklyReportProject(
      req.tenantClient!,
      requireUuid(req.params.id, "id"),
      req.body ?? {},
      officeIdFrom(req),
      { actorUserId: actorFrom(req).id },
    );
    await req.commitTransaction!();
    res.json(project);
  } catch (error) {
    next(error);
  }
});

router.delete("/projects/:id", async (req, res, next) => {
  try {
    await deactivateWeeklyReportProject(req.tenantClient!, requireUuid(req.params.id, "id"));
    await req.commitTransaction!();
    res.status(204).end();
  } catch (error) {
    next(error);
  }
});

router.post("/projects/:id/dismiss", async (req, res, next) => {
  try {
    const actor = actorFrom(req);
    const weekOf = readQueryString(req.body?.weekOf);
    if (!weekOf || !isIsoDateString(weekOf)) {
      throw new AppError(400, "weekOf must be a YYYY-MM-DD date");
    }
    const reason = typeof req.body?.reason === "string" ? req.body.reason.trim() : "";
    // A dismissal with no reason is indistinguishable from someone clearing the board, which is exactly
    // the accountability this page is meant to create.
    if (!reason) throw new AppError(400, "A reason is required to dismiss a week");

    await dismissWeeklyReportWeek(req.tenantClient!, {
      weeklyReportProjectId: requireUuid(req.params.id, "id"),
      weekOf,
      reason: reason.slice(0, 500),
      actorUserId: actor.id,
      asOf: asOfFrom(req),
    });
    await req.commitTransaction!();
    res.status(204).end();
  } catch (error) {
    next(error);
  }
});

// ---------------------------------------------------------------------------
// Reports
// ---------------------------------------------------------------------------

router.get("/reports", async (req, res, next) => {
  try {
    // UUID-guarded like every path and body id: listWeeklyReports casts this with ::uuid, so a
    // malformed filter raised 22P02 and answered 500 instead of a 400 the caller can act on.
    const projectIdFilter = readQueryString(req.query.projectId);
    const reports = await listWeeklyReports(req.tenantClient!, {
      projectId: projectIdFilter ? requireUuid(projectIdFilter, "projectId") : null,
      status: readQueryString(req.query.status),
      from: readQueryString(req.query.from),
      to: readQueryString(req.query.to),
    });
    await req.commitTransaction!();
    res.json({ reports });
  } catch (error) {
    next(error);
  }
});

router.post("/reports", async (req, res, next) => {
  try {
    const actor = actorFrom(req);
    const { report, created } = await createWeeklyReportDraft(
      req.tenantClient!,
      {
        clientSubmissionId: requireUuid(req.body?.clientSubmissionId, "clientSubmissionId"),
        weeklyReportProjectId: requireUuid(req.body?.weeklyReportProjectId, "weeklyReportProjectId"),
        weekOf: String(req.body?.weekOf ?? ""),
      },
      actor,
    );
    await req.commitTransaction!();
    // 200 on a retry, 201 on a genuine create — the field capture convention, so the phone can tell a
    // duplicate submit from a new one without parsing the body.
    res.status(created ? 201 : 200).json(report);
  } catch (error) {
    next(error);
  }
});

router.get("/reports/:id", async (req, res, next) => {
  try {
    const report = await getWeeklyReportDetail(req.tenantClient!, requireUuid(req.params.id, "id"));
    if (!report) throw new AppError(404, "Weekly report not found");
    await req.commitTransaction!();
    res.json(report);
  } catch (error) {
    next(error);
  }
});

router.patch("/reports/:id", async (req, res, next) => {
  try {
    const report = await updateWeeklyReportContent(
      req.tenantClient!,
      requireUuid(req.params.id, "id"),
      req.body ?? {},
      actorFrom(req),
    );
    await req.commitTransaction!();
    res.json(report);
  } catch (error) {
    next(error);
  }
});

router.get("/reports/:id/photo-candidates", async (req, res, next) => {
  try {
    // `total` travels with the list because the set is CAPPED. A picker that shows 300 of 412 without
    // saying so reads as the whole window, and the rows it drops are the oldest days of it.
    const { photos, total } = await listWeeklyReportPhotoCandidates(
      req.tenantClient!,
      requireUuid(req.params.id, "id"),
    );
    await req.commitTransaction!();
    res.json({ photos, total });
  } catch (error) {
    next(error);
  }
});

router.put("/reports/:id/photos", async (req, res, next) => {
  try {
    // Passed through UNCOERCED. Substituting `[]` for a malformed payload made the service's own
    // Array.isArray check unreachable, so `{"photos": "oops"}` would answer 200 and silently delete
    // every photo on the report instead of 400. An intentional clear is an explicit empty array.
    const report = await replaceWeeklyReportPhotos(
      req.tenantClient!,
      requireUuid(req.params.id, "id"),
      req.body?.photos,
      actorFrom(req),
    );
    await req.commitTransaction!();
    res.json(report);
  } catch (error) {
    next(error);
  }
});

router.post("/reports/:id/transition", async (req, res, next) => {
  try {
    // `sent` is NOT reachable here, deliberately.
    //
    // The state machine can perform the transition — the send flow calls it — but reaching it through the
    // generic endpoint would mark a report delivered, stamp `sent_at`, freeze the snapshot and light up
    // "Sent" on the board without an email existing anywhere. The client would never receive their report
    // and every surface would insist they had. Sending is `POST /reports/:id/send`, which composes the
    // message, mints the link and queues the delivery in one transaction.
    if (req.body?.to === "sent") {
      throw new AppError(400, "Use the send endpoint to send a report to the client");
    }
    const report = await transitionWeeklyReport(
      req.tenantClient!,
      requireUuid(req.params.id, "id"),
      req.body?.to,
      actorFrom(req),
    );
    await req.commitTransaction!();
    res.json(report);
  } catch (error) {
    next(error);
  }
});

// ---------------------------------------------------------------------------
// Send + corrections
// ---------------------------------------------------------------------------

/**
 * THE CRM's SEND IS A LEADERSHIP ACTION. The assigned PM's send is on the field route, and it is deferred.
 *
 * Stated as a role gate rather than left implicit, because implicit it was WRONG in a way that read as
 * right. `canPublishWeeklyReport` allows "the assigned PM or an admin/director"; the router above admits
 * admin/director/rep; and `ASSIGNABLE_ROLES` (projects-service.ts) — who may hold the PM slot at all —
 * is field_contractor/construction/admin/director. Intersect those and the assigned-PM arm can only ever
 * fire for somebody who is ALREADY an admin or director. A `construction` PM, which is the normal case,
 * gets 403 at the router before any of it runs.
 *
 * So the shipped CRM capability is exactly "an admin or director in this office may send any of that
 * office's client reports", and this line says so. The alternative — widening the router to admit
 * `construction` — is deliberately NOT taken: this router is the office-wide leadership board, the client
 * contact book and the dismissal ledger, and the construction role's CRM boundary is a known open issue.
 *
 * The assigned PM's own send belongs on /api/field/weekly-reports, where that PM already authenticates and
 * where `canPublishWeeklyReport`'s assigned-PM arm becomes reachable and meaningful. That mount is the
 * mobile PR's work (the app's Reports group has not merged), which is why every piece of composition,
 * validation and delivery lives in send-service.ts: that PR adds a route and no logic.
 */
const requireWeeklyReportSender = requireRole("admin", "director");

/**
 * The send modal, COMPOSED SERVER-SIDE and returned as data.
 *
 * The CRM and T-Rock Cam both render this and both post the same mutation back, which is the whole reason
 * "review from either surface" does not mean two implementations of the recipient rules, the subject line
 * and the body.
 */
router.get("/reports/:id/send-draft", requireWeeklyReportSender, async (req, res, next) => {
  try {
    const draft = await buildWeeklyReportSendDraft(
      req.tenantClient!,
      requireUuid(req.params.id, "id"),
      actorFrom(req),
    );
    await req.commitTransaction!();
    res.json(draft);
  } catch (error) {
    next(error);
  }
});

/**
 * Send the report to the client.
 *
 * Everything below the commit is a queued job. What happens INSIDE the transaction is the part that must
 * be atomic: the `approved -> sent` transition, the frozen header snapshot, the minted 180-day token, and
 * the job row that will deliver it.
 */
router.post("/reports/:id/send", requireWeeklyReportSender, async (req, res, next) => {
  try {
    // CHECKED BEFORE ANYTHING IS MINTED. This used to be a console.warn AFTER the commit — after the
    // token existed, the snapshot was frozen, the report was terminally `sent` and the delivery job was
    // queued. Nothing downstream of that can stop the email, so a warning there could only describe a
    // client link that had already gone out. `publicViewerBaseUrl` falls back to FRONTEND_URL and then to
    // the request's own host, so an unset var quietly mints links against the SPA-only CRM host, which
    // does not serve /wr: the client's one way into their report 404s, and only the client sees it.
    assertClientLinksAreConfigured();
    const office = officeContextFrom(req);
    const { report, shareUrl } = await sendWeeklyReport(req.tenantClient!, {
      reportId: requireUuid(req.params.id, "id"),
      office: { tenantId: office.tenantId, slug: office.slug },
      actor: actorFrom(req),
      payload: req.body ?? {},
      shareUrlFor: (rawToken) => weeklyReportShareUrl(req, rawToken),
    });
    await req.commitTransaction!();
    res.status(202).json({ report, shareUrl });
  } catch (error) {
    next(error);
  }
});

/**
 * Queue the same message again for a send that has not reached the client.
 *
 * `acknowledgeDuplicateRisk` is the caller confirming they understand that past the provider's 24-hour
 * idempotency window a replay is a genuinely second email, not a no-op. Default false: silence must mean
 * the safe answer.
 */
router.post("/reports/:id/send/retry", requireWeeklyReportSender, async (req, res, next) => {
  try {
    const office = officeContextFrom(req);
    const report = await retryWeeklyReportSend(
      req.tenantClient!,
      requireUuid(req.params.id, "id"),
      actorFrom(req),
      { tenantId: office.tenantId, slug: office.slug },
      { acknowledgeDuplicateRisk: req.body?.acknowledgeDuplicateRisk === true },
    );
    await req.commitTransaction!();
    res.status(202).json(report);
  } catch (error) {
    next(error);
  }
});

/**
 * Clone a sent report to the next version so it can be corrected.
 *
 * Answers 201 with the new report. It is NOT sent by this call and it does NOT supersede the original yet
 * — a correction the PM abandons half-written must not put "a newer version was issued" in front of a
 * client with nothing behind it.
 */
router.post("/reports/:id/correction", requireWeeklyReportSender, async (req, res, next) => {
  try {
    const correction = await createWeeklyReportCorrection(
      req.tenantClient!,
      requireUuid(req.params.id, "id"),
      actorFrom(req),
    );
    await req.commitTransaction!();
    res.status(201).json(correction);
  } catch (error) {
    next(error);
  }
});

// T-ROCK CAM — AND THE ASSIGNED PM'S SEND, WHICH DOES NOT EXIST YET.
//
// The four endpoints above are the LEADERSHIP send: admin/director only, as `requireWeeklyReportSender`
// states. They are mounted on the CRM router, which the app cannot reach — its surface is /api/field, a
// separate mount with its own authorisation.
//
// The assigned PM is normally a `construction` or `field_contractor` user (ASSIGNABLE_ROLES), so they are
// refused here by design and have NO send capability in this PR. That is the deferral, stated plainly so
// nobody reads `canPublishWeeklyReport`'s assigned-PM arm as a shipped feature: on this router that arm
// can only ever fire for somebody who is already an admin or director, and it exists for the field mount.
//
// Attaching that mount is deliberately left to the mobile PR: the app's Reports group (#1073) has not
// merged, so there is nowhere for the modal to live and a field route added now would be an unreachable,
// untested authorisation surface. The composition, validation and delivery are all in send-service.ts
// precisely so that PR adds a route and no logic.

// ---------------------------------------------------------------------------
// PDF + the client share link
// ---------------------------------------------------------------------------

/** The office context both surfaces need. Absent means the request never went through tenantMiddleware. */
function officeContextFrom(req: Request): { slug: string; tenantId: string } {
  const slug = req.officeSlug;
  const tenantId = req.user?.activeOfficeId;
  if (!slug || !tenantId) throw new AppError(400, "Office context not available");
  return { slug, tenantId };
}

/**
 * A presigned download of the report PDF, rendering it first when the stored artifact is missing or stale.
 *
 * The transaction is COMMITTED before the render. Rendering downloads and transcodes every photo and then
 * uploads to R2 — seconds of network and CPU — and holding a pooled connection across that is the
 * documented cause of the API pool saturating and every deal list answering "Couldn't load deals".
 *
 * Presigned here, unlike on the public viewer, because the caller is CRM staff: the object key embeds the
 * deal number, which is theirs to see and which the client's link deliberately hides.
 */
router.get("/reports/:id/pdf", async (req, res, next) => {
  try {
    const office = officeContextFrom(req);
    const source = await loadWeeklyReportPdfSource(req.tenantClient!, requireUuid(req.params.id, "id"));
    await req.commitTransaction!();
    if (!source) throw new AppError(404, "Weekly report not found");

    const r2Key = await resolveArtifactKey(office.slug, source);
    const filename = weeklyReportPdfFilename(source.view);
    res.json({ url: await weeklyReportPdfDownloadUrl(r2Key, filename), filename });
  } catch (error) {
    next(error);
  }
});

/**
 * Load a report and assert the caller may put it, or take it back, in front of a client.
 *
 * The router's own gate is `admin | director | rep`, which is the read gate for the dashboard. Minting the
 * 180-day unauthenticated URL is not a read — it IS the act of publication, so it takes the same
 * assigned-PM-or-leadership check that moving the report to `sent` takes. Otherwise any rep in the office
 * could publish a construction report to its client without the PM ever being involved.
 */
/**
 * Load a report for publication, LOCKING both rows it authorises against.
 *
 * The two inputs to that decision — the report's status and the project's assigned PM — are both
 * mutable by other requests, and this one hands out a durable public credential. Plain reads left two
 * windows open: a PM could pass the check, lose the assignment before commit, and still walk away with
 * a live client URL; and a token minted while the report was concurrently withdrawn would start
 * working by itself the moment anyone re-approved it.
 *
 * FOR UPDATE holds both until this transaction commits, so the credential can only be issued against
 * the state that actually authorised it.
 */
async function loadPublishableReport(
  req: Request,
  id: string,
  // Revoking must survive the setup being archived. A soft-deactivated project's links keep resolving
  // for the rest of their 180 days by design, and there is no restore path — so an `is_active` filter
  // here left a mistakenly-shared or compromised link permanently un-killable, by anyone, including
  // leadership. Minting stays blocked for an archived setup; withdrawing does not.
  options: { allowInactiveProject?: boolean } = {},
) {
  const locked = await req.tenantClient!.query(
    `SELECT id, weekly_report_project_id, status
       FROM weekly_reports
      WHERE id = $1::uuid AND is_active
      FOR UPDATE`,
    [id],
  );
  if (!locked.rows[0]) throw new AppError(404, "Weekly report not found");

  const lockedProject = await req.tenantClient!.query(
    `SELECT * FROM weekly_report_projects
      WHERE id = $1::uuid ${options.allowInactiveProject ? "" : "AND is_active"}
      FOR UPDATE`,
    [locked.rows[0].weekly_report_project_id],
  );
  const project = lockedProject.rows[0];
  if (!project) throw new AppError(404, "Weekly report project not found");
  if (!canPublishWeeklyReport(project, actorFrom(req))) {
    throw new AppError(403, "Only the assigned project manager can issue or withdraw a client link");
  }

  // Re-read the full detail AFTER the lock, so status is the locked value rather than a pre-lock read.
  const report = await getWeeklyReportDetail(req.tenantClient!, id);
  if (!report) throw new AppError(404, "Weekly report not found");
  return report;
}

/**
 * Mint a durable client link.
 *
 * Only for an APPROVED or SENT report. A link to a draft is a link to content no PM has reviewed, in front
 * of the client — which defeats the approval gate rather than merely bending it. The viewer re-checks this
 * on every request too (see isWeeklyReportShareableStatus): `approved` is not terminal, and a mint-time
 * check alone would keep serving a report the superintendent had since pulled back and rewritten.
 *
 * Each call mints a NEW link rather than returning the existing one, so revoking the link you just emailed
 * cannot kill the one the client is already reading.
 */
router.post("/reports/:id/share-link", async (req, res, next) => {
  try {
    const office = officeContextFrom(req);
    const actor = actorFrom(req);
    const id = requireUuid(req.params.id, "id");
    const report = await loadPublishableReport(req, id);
    if (!isWeeklyReportShareableStatus(report.status)) {
      throw new AppError(409, "A client link can only be created once the PM has approved the report");
    }

    const { rawToken, token } = await mintWeeklyReportToken(req.tenantClient!, {
      weeklyReportId: id,
      tenantId: office.tenantId,
      officeSlug: office.slug,
      createdByUserId: actor.id,
    });
    await req.commitTransaction!();

    // The link's host is config, and getting it wrong is invisible from in here: `/wr` is served by the API
    // service, so a base URL pointing at the field host or an SPA-only frontend mints a 201 with a URL that
    // 404s for the client and for nobody else. Warn loudly while the deploy prerequisite is outstanding.
    if (!process.env.PUBLIC_SHARE_BASE_URL?.trim()) {
      console.warn(
        "[weekly-report] PUBLIC_SHARE_BASE_URL is unset — client links are being minted against FRONTEND_URL " +
          "or the request host, neither of which is guaranteed to serve /wr.",
      );
    }
    // The raw token is returned EXACTLY ONCE, here. Only its hash is stored, so this response is the only
    // moment the usable link exists anywhere but in the email that carries it.
    res.status(201).json({ url: weeklyReportShareUrl(req, rawToken), token });
  } catch (error) {
    next(error);
  }
});

router.get("/reports/:id/share-link", async (req, res, next) => {
  try {
    const office = officeContextFrom(req);
    const reportId = requireUuid(req.params.id, "id");
    // The SAME assignment check the mint and revoke handlers run. The role gate is not enough on its
    // own: it admits every rep in the office, and without this any of them could hand this route another
    // rep's report uuid and read back who minted each link and its active/revoked/expiry history.
    // Archived setups are listable for the same reason they are revocable: you cannot withdraw a link
    // you cannot see.
    await loadPublishableReport(req, reportId, { allowInactiveProject: true });
    const tokens = await listWeeklyReportTokens(req.tenantClient!, reportId, office.tenantId);
    await req.commitTransaction!();
    res.json({ tokens });
  } catch (error) {
    next(error);
  }
});

router.post("/reports/:id/share-link/:tokenId/revoke", async (req, res, next) => {
  try {
    const office = officeContextFrom(req);
    const reportId = requireUuid(req.params.id, "id");
    await loadPublishableReport(req, reportId, { allowInactiveProject: true });
    const token = await revokeWeeklyReportToken(req.tenantClient!, {
      tokenId: requireUuid(req.params.tokenId, "tokenId"),
      tenantId: office.tenantId,
      weeklyReportId: reportId,
    });
    await req.commitTransaction!();
    res.json({ token });
  } catch (error) {
    next(error);
  }
});

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

router.get("/settings", async (req, res, next) => {
  try {
    const settings = await getWeeklyReportSettings(req.tenantClient!);
    await req.commitTransaction!();
    res.json(settings);
  } catch (error) {
    next(error);
  }
});

// Who receives the due-day digest is a leadership decision, and this mount is reachable by every CRM
// role — including `construction`, which is how superintendents get in. Anyone could otherwise quietly
// remove themselves from the list that reports on them.
router.put("/settings", requireRole("admin", "director"), async (req, res, next) => {
  try {
    const actor = actorFrom(req);
    const settings = await updateWeeklyReportSettings(
      req.tenantClient!,
      req.body?.leadershipRecipientEmails,
      actor.id,
    );
    await req.commitTransaction!();
    res.json(settings);
  } catch (error) {
    next(error);
  }
});

export const weeklyReportRoutes = router;
