// The T-Rock Cam half of Weekly Reports, mounted under /api/field/weekly-reports.
//
// WHY A SECOND ROUTER RATHER THAN OPENING THE CRM ONE. The two surfaces authenticate differently and
// carry different blast radii, not different logic. A field session is a `surface: "field"` JWT that the
// CRM mount rejects outright (#722), and the CRM router is gated to admin/director/rep precisely because
// its dashboard, settings and setup endpoints expose the whole office. So this file is routing and
// authentication only: every handler calls the SAME service function the CRM router calls, and every
// authorisation decision is made inside those services against `trock_super_user_id` /
// `trock_pm_user_id`. Duplicating a rule here would create exactly the divergence the design set out to
// avoid — the PM can review on either surface, so a gate that exists on one and not the other is a gate.
//
// The one thing this file adds is presigned image URLs. The services deal in file ids because the PDF
// renderer and the public viewer resolve their own; a phone needs a URL it can put in an <Image>.

import { Router, type Request } from "express";
import { businessToday } from "../../lib/period.js";
import { AppError } from "../../middleware/error-handler.js";
import { requireFieldContractor } from "../../middleware/field-auth.js";
import { tenantMiddleware } from "../../middleware/tenant.js";
import { resolvePhotoDisplayUrls } from "../files/service.js";
import { listWeeklyReportAssignments } from "./assignments-service.js";
import {
  createWeeklyReportDraft,
  getWeeklyReportForActor,
  listWeeklyReportPhotoCandidates,
  replaceWeeklyReportPhotos,
  transitionWeeklyReport,
  updateWeeklyReportContent,
  type WeeklyReportActor,
} from "./reports-service.js";
import { toFieldWeeklyReportProject, type QueryExecutor } from "./projects-service.js";

const router = Router();
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// Every route needs a field session AND an office-bound transaction. tenantMiddleware pins the search_path
// to the user's ACTIVE office (the `x-office-id` header requireFieldContractor already validated) and
// hands back both a drizzle handle and the raw PoolClient the weekly-report services are written against.
//
// Note this is single-office, unlike the field photo routes' cross-office fan-out. A weekly report is
// authored by a named superintendent against a setup row a PM created in one office; there is no
// "browse every office's projects" case to serve, and fanning out would mean resolving which office owns
// a report before every mutation for no reachable benefit.
router.use(requireFieldContractor, tenantMiddleware);

function requireUuid(value: unknown, label: string): string {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
    throw new AppError(400, `${label} must be a valid UUID`);
  }
  return value;
}

/**
 * The acting user, as the services understand one.
 *
 * `role` here is the EFFECTIVE role requireFieldContractor resolved (including an office-scoped
 * override), which is what decides whether admin/director powers apply. Reading `req.user.role` instead
 * would use the home-office role and could grant elevation in an office where the user has none.
 */
function actorFrom(req: Request): WeeklyReportActor {
  const user = req.fieldUser;
  if (!user?.id) throw new AppError(401, "Authentication required");
  return { id: user.id, role: String(user.role ?? "") };
}

/** "Today" in the OFFICE's timezone. A crew in Dallas is not on the server's UTC clock. */
function asOfFrom(): string {
  return businessToday();
}

/**
 * Presign a thumbnail + full-size URL for each file id, in ONE query.
 *
 * A per-photo `getFileDownloadUrl` would issue a SELECT each; the picker's window is 14 days of a jobsite
 * and routinely holds a hundred photos, and req.tenantClient is a single connection so those SELECTs
 * serialise. Presigning is a local HMAC operation, so the batched read is the only real cost.
 */
async function resolvePhotoUrls(
  client: QueryExecutor,
  fileIds: string[],
): Promise<Map<string, { thumbnailUrl: string | null; fullUrl: string | null }>> {
  const urls = new Map<string, { thumbnailUrl: string | null; fullUrl: string | null }>();
  if (fileIds.length === 0) return urls;

  const result = await client.query(
    `SELECT id, r2_key, thumbnail_r2_key, external_url, external_thumbnail_url,
            display_name, file_extension
       FROM files
      WHERE id = ANY($1::uuid[])`,
    [fileIds],
  );
  for (const row of result.rows) {
    // A single unresolvable photo must not fail the whole picker — it renders as a placeholder tile,
    // which is what the grid already does for a null url.
    try {
      urls.set(
        row.id,
        await resolvePhotoDisplayUrls({
          r2Key: row.r2_key,
          thumbnailR2Key: row.thumbnail_r2_key,
          externalUrl: row.external_url,
          externalThumbnailUrl: row.external_thumbnail_url,
          displayName: row.display_name,
          fileExtension: row.file_extension,
        }),
      );
    } catch {
      urls.set(row.id, { thumbnailUrl: null, fullUrl: null });
    }
  }
  return urls;
}

async function withPhotoUrls<T extends { fileId: string }>(
  client: QueryExecutor,
  photos: T[],
): Promise<Array<T & { thumbnailUrl: string | null; fullUrl: string | null }>> {
  const urls = await resolvePhotoUrls(client, photos.map((photo) => photo.fileId));
  return photos.map((photo) => ({
    ...photo,
    thumbnailUrl: urls.get(photo.fileId)?.thumbnailUrl ?? null,
    fullUrl: urls.get(photo.fileId)?.fullUrl ?? null,
  }));
}

// ---------------------------------------------------------------------------
// The hub
// ---------------------------------------------------------------------------

// Everything the Reports tab needs in one round trip: the projects this user owes reports on, and
// anything sitting in their PM queue. One call rather than two because the hub renders both together and
// a jobsite LTE connection makes every extra request a chance to show half a screen.
router.get("/assignments", async (req, res, next) => {
  try {
    const actor = actorFrom(req);
    const data = await listWeeklyReportAssignments(req.tenantClient!, {
      userId: actor.id,
      role: actor.role,
      asOf: asOfFrom(),
    });
    await req.commitTransaction!();
    res.json(data);
  } catch (error) {
    next(error);
  }
});

// ---------------------------------------------------------------------------
// Reports
// ---------------------------------------------------------------------------

// Start (or recover) the week's draft. Idempotent on clientSubmissionId, which the phone stamps once when
// the local draft is created and reuses on every retry — so a submit that times out on the way back does
// not produce a second report for the week. 200 on a retry, 201 on a genuine create, matching the field
// capture convention so the app can tell them apart without parsing the body.
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
    res.status(created ? 201 : 200).json({ report });
  } catch (error) {
    next(error);
  }
});

router.get("/reports/:id", async (req, res, next) => {
  try {
    const { report, project, permissions } = await getWeeklyReportForActor(
      req.tenantClient!,
      requireUuid(req.params.id, "id"),
      actorFrom(req),
    );
    const photos = await withPhotoUrls(req.tenantClient!, report.photos);
    await req.commitTransaction!();
    res.json({
      report: { ...report, photos },
      project: toFieldWeeklyReportProject(project),
      permissions,
    });
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
    res.json({ report });
  } catch (error) {
    next(error);
  }
});

// The picker's candidate set. Authorised FIRST — listWeeklyReportPhotoCandidates has no view check of its
// own (the CRM router's role gate stood in for one), and without this any field user could enumerate a
// project's photo descriptions by report id.
router.get("/reports/:id/photo-candidates", async (req, res, next) => {
  try {
    const id = requireUuid(req.params.id, "id");
    await getWeeklyReportForActor(req.tenantClient!, id, actorFrom(req));
    const candidates = await listWeeklyReportPhotoCandidates(req.tenantClient!, id);
    const photos = await withPhotoUrls(req.tenantClient!, candidates);
    await req.commitTransaction!();
    res.json({ photos });
  } catch (error) {
    next(error);
  }
});

router.put("/reports/:id/photos", async (req, res, next) => {
  try {
    // Passed through UNCOERCED so the service's own Array.isArray check stays reachable: substituting []
    // for a malformed payload would answer 200 and silently delete every photo on the report.
    const report = await replaceWeeklyReportPhotos(
      req.tenantClient!,
      requireUuid(req.params.id, "id"),
      req.body?.photos,
      actorFrom(req),
    );
    const photos = await withPhotoUrls(req.tenantClient!, report.photos);
    await req.commitTransaction!();
    res.json({ report: { ...report, photos } });
  } catch (error) {
    next(error);
  }
});

// Submit for review / approve / bounce back. The PM gate lives in canTransitionAs, not here — a
// superintendent posting `{"to":"approved"}` from a patched build is refused by the service.
router.post("/reports/:id/transition", async (req, res, next) => {
  try {
    // `sent` is refused on this surface until the send flow exists (PR 5). The service would allow a PM
    // to reach it, and the effect would be a report stamped sent_by/sent_at with its header frozen and
    // NOTHING delivered — permanently immutable, invisible on the dashboard as outstanding, and with no
    // way back, because corrections are a new version the send flow has not shipped either.
    if (req.body?.to === "sent") {
      throw new AppError(409, "Sending a weekly report is not available in the app yet");
    }
    const report = await transitionWeeklyReport(
      req.tenantClient!,
      requireUuid(req.params.id, "id"),
      req.body?.to,
      actorFrom(req),
    );
    await req.commitTransaction!();
    res.json({ report });
  } catch (error) {
    next(error);
  }
});

export const weeklyReportFieldRoutes = router;
