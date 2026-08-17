import { Router, type Request } from "express";
import { businessToday } from "../../lib/period.js";
import { AppError } from "../../middleware/error-handler.js";
import { requireRole } from "../../middleware/rbac.js";
import {
  createWeeklyReportProject,
  deactivateWeeklyReportProject,
  getWeeklyReportProject,
  getWeeklyReportSettings,
  listWeeklyReportAssignableUsers,
  listWeeklyReportProjects,
  updateWeeklyReportProject,
  updateWeeklyReportSettings,
} from "./projects-service.js";
import {
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
    const project = await updateWeeklyReportProject(
      req.tenantClient!,
      requireUuid(req.params.id, "id"),
      req.body ?? {},
      officeIdFrom(req),
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
    const photos = await listWeeklyReportPhotoCandidates(
      req.tenantClient!,
      requireUuid(req.params.id, "id"),
    );
    await req.commitTransaction!();
    res.json({ photos });
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
