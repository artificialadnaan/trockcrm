import express, { Router } from "express";
import { requireFieldContractor } from "../../middleware/field-auth.js";
import { AppError } from "../../middleware/error-handler.js";
import { tenantMiddleware } from "../../middleware/tenant.js";
import { toFieldUserResponse } from "../field-users/service.js";
import {
  buildFieldPhotoDownloadUrls,
  confirmFieldPhotoUpload,
  assignPendingFieldPhotoTarget,
  listPendingFieldPhotos,
  requestFieldPhotoUploadUrl,
} from "./photos-service.js";
import {
  getFieldPhotoTranscriptionConfig,
  transcribeAndPersistFieldPhotoDescription,
  transcribePhotoDescriptionAudio,
} from "./photo-transcription-service.js";
import { updateFieldPhotoMetadata } from "./photo-metadata-service.js";
import {
  deleteFieldPhotoTag,
  replaceFieldPhotoTags,
  searchFieldProjectTags,
} from "./photo-tags-service.js";
import {
  generateFieldPhotoReport,
  getFieldProjectReportDownload,
  listFieldProjectReports,
  previewFieldPhotoReport,
} from "./photo-reports-service.js";
import {
  createFieldScorecard,
  finalizeFieldScorecardArtifacts,
  getFieldScorecardDetail,
  getFieldScorecardPdfArtifactState,
  isStoredScorecardPdfAvailable,
  listFieldScorecardsForProject,
  listRecentFieldScorecards,
  presignFieldScorecardPdf,
  updateFieldScorecard,
} from "./scorecards-service.js";
import { parseScorecardSubmission, parseScorecardUpdate } from "./scorecard-submission.js";
import { getFileDownloadUrl } from "../files/service.js";
import {
  assertAccessibleFieldCaptureTarget,
  assertActiveFieldProject,
  FIELD_NEARBY_DEFAULT_LIMIT,
  FIELD_PROJECTS_MAX_FETCH,
  listFieldProjects,
  listFieldProjectPhotos,
  getFieldProject,
  listNearbyFieldCaptureTargets,
  listNearbyFieldProjects,
  listStarredFieldProjects,
  mergeFieldCaptureTargets,
  mergeFieldProjects,
  mergeNearbyProjects,
  searchFieldCaptureTargets,
  starFieldProject,
  unstarFieldProject,
  type FieldProject,
} from "./projects-service.js";
import { assertValidCaptureTargetIds, assertValidUuid } from "./photos-service.js";
import {
  assertFanOutNotFullyDegraded,
  fanOutActiveOffices,
  getFieldOfficeById,
  isFieldCrossOfficeWritesEnabled,
  officeTag,
  resolveFieldWriteOffice,
  resolveWriteOffice,
  runInOffice,
  runInOfficeTransaction,
  withResolvedOffice,
  type FieldOffice,
  type FieldTenantDb,
} from "./cross-office.js";
import { assertPhotosBelongToDeal, generatePublicToken } from "../public-photo-tokens/service.js";
import { publicPhotoShareUrl } from "../public-photo-tokens/public-share-url.js";
import { resolveScorecardTeamNames } from "../deals/team-service.js";
import {
  assertScorecardEvidenceUploadAccess,
  discardScorecardEditEvidence,
} from "./scorecard-evidence-upload.js";
import { registerCorrectiveActionRoutes } from "./corrective-action-routes.js";

// Default capture-target picker page size (mirrors searchPhotoUploadTargets' internal default), used as
// the GLOBAL cap when the cross-office picker merges per-office results.
const FIELD_CAPTURE_TARGET_DEFAULT_LIMIT = 30;

export const fieldRoutes = Router();

// Corrective-action read + itemized-response endpoints (session OR recipient-bound token auth). Registered
// on the field router; the token path intentionally bypasses requireFieldContractor (email-only responders
// have no session) and authorizes via the scorecard's office + the ?token instead.
registerCorrectiveActionRoutes(fieldRoutes);

function parseOptionalPositiveInt(value: unknown): number | undefined {
  if (typeof value !== "string") return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 100) {
    throw new AppError(400, "limit must be a positive integer between 1 and 100");
  }
  return parsed;
}

function parseOptionalScorecardId(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !value.trim()) {
    throw new AppError(400, "scorecardId must be a valid UUID.");
  }
  const scorecardId = value.trim();
  assertValidUuid(scorecardId, "scorecardId");
  return scorecardId;
}

function parseOptionalClientUploadId(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !value.trim() || value.trim().length > 64) {
    throw new AppError(400, "clientUploadId must be a non-empty string of at most 64 characters.");
  }
  return value.trim();
}

function parseScorecardDiscardEvidenceIds(value: unknown): string[] {
  if (!Array.isArray(value)) throw new AppError(400, "clientUploadIds must be an array.");
  if (value.length > 100) throw new AppError(400, "At most 100 evidence uploads can be discarded at once.");
  const ids = value.map((candidate) => {
    if (typeof candidate !== "string" || !candidate.trim() || candidate.trim().length > 64) {
      throw new AppError(400, "Each clientUploadId must be a non-empty string of at most 64 characters.");
    }
    return candidate.trim();
  });
  return [...new Set(ids)];
}

function parseRequiredCoordinate(value: unknown, name: "lat" | "lng", min: number, max: number): number {
  // Reject blanks BEFORE coercing: Number("") and Number("   ") both yield 0, which would otherwise pass
  // the range check below and silently rank projects around (0,0) for a coordinate the caller never sent
  // (e.g. `?lat=&lng=` from generic query/form serialization). Treat empty/whitespace as missing.
  if (typeof value !== "string" || value.trim() === "") {
    throw new AppError(400, `Valid ${name} query parameter is required.`);
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) {
    throw new AppError(400, `Valid ${name} query parameter is required.`);
  }
  return parsed;
}

function requestAuditContext(req: any) {
  const userAgentHeader = req.headers?.["user-agent"];
  return {
    ipAddress: req.ip ?? null,
    userAgent: Array.isArray(userAgentHeader) ? userAgentHeader.join(", ") : userAgentHeader ?? null,
  };
}

// ─── Cross-office write routing (Phase 2b) ───────────────────────────────────────────────────────
// These replace tenantMiddleware on the write routes. Flag OFF (or no target) → the uploader's active
// office in a transaction = byte-for-byte today's behavior. Flag ON → the resolved DEAL/FILE office,
// re-binding search_path (here), the R2 key slug, and job_queue.office_id (in the services).

/** Run a DEAL/LEAD-targeted field write in the resolved (or uploader's) office, transactionally. */
async function runFieldDealWrite<T>(
  req: any,
  target: { dealId?: string; leadId?: string; opportunityId?: string },
  run: (db: FieldTenantDb, office: FieldOffice) => Promise<T>,
  notFoundMessage?: string,
): Promise<T> {
  // Validate id FORMAT before resolving — an invalid uuid must be a clean 400, not a `::uuid` cast
  // error swallowed by the resolver fan-out and surfaced as a misleading 503.
  assertValidCaptureTargetIds(target);
  const office = await resolveFieldWriteOffice(req.fieldUser!.tenantId, target, notFoundMessage);
  return runInOfficeTransaction(office, req.fieldUser!.id, run);
}

/**
 * Photo writes ordinarily keep the generic cross-office feature flag semantics. Submitted-scorecard edit
 * evidence is the narrow exception: resolve by immutable scorecard id, then authorize owner + deal inside
 * that office before minting or confirming anything.
 */
async function runFieldPhotoWrite<T>(
  req: any,
  target: { dealId?: string; leadId?: string; opportunityId?: string },
  scorecardId: string | undefined,
  run: (db: FieldTenantDb, office: FieldOffice) => Promise<T>,
  notFoundMessage?: string,
): Promise<T> {
  if (!scorecardId) return runFieldDealWrite(req, target, run, notFoundMessage);
  assertValidCaptureTargetIds(target);
  const office = await resolveWriteOffice("scorecard", scorecardId, "Scorecard not found");
  return runInOfficeTransaction(office, req.fieldUser!.id, async (db, resolvedOffice) => {
    await assertScorecardEvidenceUploadAccess(db, {
      scorecardId,
      userId: req.fieldUser!.id,
      target,
    });
    return run(db, resolvedOffice);
  });
}

/** Run a FILE-targeted field write (tags, transcription) in the photo's resolved (or uploader's) office. */
async function runFieldFileWrite<T>(
  req: any,
  fileId: string,
  run: (db: FieldTenantDb, office: FieldOffice) => Promise<T>,
  notFoundMessage = "Photo not found",
): Promise<T> {
  assertValidUuid(fileId, "photoId");
  const office = isFieldCrossOfficeWritesEnabled()
    ? await resolveWriteOffice("file", fileId, notFoundMessage)
    : await getFieldOfficeById(req.fieldUser!.tenantId);
  return runInOfficeTransaction(office, req.fieldUser!.id, run);
}

function rawAudioBody() {
  if (process.env.NODE_ENV === "test") {
    return (_req: any, _res: any, next: (err?: unknown) => void) => next();
  }
  return express.raw({
    type: ["audio/*", "application/octet-stream"],
    limit: "25mb",
  });
}

fieldRoutes.get("/me", requireFieldContractor, (req, res) => {
  res.json({
    user: toFieldUserResponse(req.fieldUser!),
  });
});

const fieldProjectMiddleware = [requireFieldContractor, tenantMiddleware] as const;

// Cross-office (field is office-agnostic): fan out the active-project list over ALL active offices,
// stamp each project with its owning office (dealNumber/name are unique per-schema only, so cross-office
// rows can be visually identical), merge photos-first then by recency (via mergeFieldProjects), and
// paginate over the merged set. One office failing degrades gracefully — its slug is surfaced in
// `degradedOffices`, the rest still return.
fieldRoutes.get("/projects", requireFieldContractor, async (req, res, next) => {
  try {
    const access = { userId: req.fieldUser!.id, userRole: req.fieldUser!.role };
    const status = req.query.status as string | undefined;
    if (status && status !== "active") {
      throw new AppError(400, "Only active field projects are supported");
    }
    const page = req.query.page ? Math.max(1, parseInt(req.query.page as string, 10)) : 1;
    const perPage = req.query.perPage ? Math.min(100, Math.max(1, parseInt(req.query.perPage as string, 10))) : 50;
    const offset = (page - 1) * perPage;
    // Fetch enough from EACH office to cover the requested window before merging (cross-office offset
    // can't be pushed into per-office SQL). Bounded by FIELD_PROJECTS_MAX_FETCH so a single dominant
    // office (e.g. Dallas with 1,275 active projects) can still be paged through up to that depth — the
    // earlier 100-row cap silently returned empty/wrong pages beyond page 2. Beyond the bound, narrow
    // via search.
    const fetchPerPage = Math.min(FIELD_PROJECTS_MAX_FETCH, offset + perPage);
    const { results, failures } = assertFanOutNotFullyDegraded(
      await fanOutActiveOffices((officeDb) =>
        listFieldProjects(officeDb, access, {
          search: req.query.search as string | undefined,
          status,
          page: 1,
          perPage: fetchPerPage,
        }),
      ),
    );
    // Photos-first cross-office order (mirrors the per-office SQL ORDER BY); the page slice is applied
    // to the merged set below.
    const merged = mergeFieldProjects(
      results.map(({ office, value }) => ({ office, projects: value.projects })),
    );
    const total = results.reduce((sum, { value }) => sum + value.total, 0);
    res.json({
      projects: merged.slice(offset, offset + perPage),
      total,
      page,
      perPage,
      degradedOffices: failures.map((failure) => failure.office.slug),
    });
  } catch (err) {
    next(err);
  }
});

fieldRoutes.get("/projects/starred", requireFieldContractor, async (req, res, next) => {
  try {
    const access = { userId: req.fieldUser!.id, userRole: req.fieldUser!.role };
    const { results, failures } = assertFanOutNotFullyDegraded(
      await fanOutActiveOffices((officeDb) => listStarredFieldProjects(officeDb, access)),
    );
    const projects = results
      .flatMap(({ office, value }) => value.projects.map((project: FieldProject) => ({ ...project, ...officeTag(office) })))
      .sort((a, b) => (b.lastActivityAt ?? "").localeCompare(a.lastActivityAt ?? ""));
    res.json({ projects, degradedOffices: failures.map((failure) => failure.office.slug) });
  } catch (err) {
    next(err);
  }
});

// Nearby: the 3 active projects CLOSEST to the device's GPS, across ALL offices. Like /projects this
// fans out per-office (field is office-agnostic), but each office computes distance in SQL and returns a
// few candidates; we then merge + re-sort by distance globally and slice to 3 so the result is the true
// nearest 3 OVERALL, not nearest-3-per-office. Registered BEFORE the `/projects/:dealId` param routes so
// "nearby" is never captured as a :dealId. Read-only (no deal mutation).
fieldRoutes.get("/projects/nearby", requireFieldContractor, async (req, res, next) => {
  try {
    const access = { userId: req.fieldUser!.id, userRole: req.fieldUser!.role };
    // parseRequiredCoordinate rejects missing/blank/out-of-range values up front (a 400), so an
    // out-of-range value (e.g. lat=999) never reaches the per-office calls where it would throw inside
    // every office and surface as a misleading fan-out 503.
    const lat = parseRequiredCoordinate(req.query.lat, "lat", -90, 90);
    const lng = parseRequiredCoordinate(req.query.lng, "lng", -180, 180);
    const { results, failures } = assertFanOutNotFullyDegraded(
      await fanOutActiveOffices((officeDb) =>
        listNearbyFieldProjects(officeDb, access, { lat, lng, limit: FIELD_NEARBY_DEFAULT_LIMIT }),
      ),
    );
    const projects = mergeNearbyProjects(
      results.map(({ office, value }) => ({ office, projects: value.projects })),
      3,
    );
    res.json({ projects, degradedOffices: failures.map((failure) => failure.office.slug) });
  } catch (err) {
    next(err);
  }
});

// Single-project metadata by id. Registered AFTER the literal /projects/starred and /projects/nearby
// routes so `:dealId` doesn't shadow them. The detail page uses this instead of scanning the paginated
// list, so opening a project never depends on it being inside the list window — photos-first ordering
// pushes zero-photo projects past the first page in large offices, and a list scan would 404 them (and
// drop the office context the off-office write guard relies on).
fieldRoutes.get("/projects/:dealId", requireFieldContractor, async (req, res, next) => {
  try {
    const access = { userId: req.fieldUser!.id, userRole: req.fieldUser!.role };
    const dealId = String(req.params.dealId);
    // Validate FORMAT before resolving the office: a non-uuid would otherwise reach the resolver's
    // per-office `::uuid` cast, fail in every office, and surface as a misleading 503 instead of a 400.
    assertValidUuid(dealId, "dealId");
    const { value, office } = await withResolvedOffice(
      "deal",
      dealId,
      (officeDb) => getFieldProject(officeDb, access, dealId),
      "Project not found",
    );
    res.json({ project: { ...value, ...officeTag(office) } });
  } catch (err) {
    next(err);
  }
});

fieldRoutes.post("/projects/:dealId/star", requireFieldContractor, async (req, res, next) => {
  try {
    const dealId = String(req.params.dealId);
    const result = await runFieldDealWrite(req, { dealId }, (db) =>
      starFieldProject(db, { userId: req.fieldUser!.id, userRole: req.fieldUser!.role }, dealId),
      "Project not found",
    );
    res.json(result);
  } catch (err) {
    next(err);
  }
});

fieldRoutes.delete("/projects/:dealId/star", requireFieldContractor, async (req, res, next) => {
  try {
    const dealId = String(req.params.dealId);
    const result = await runFieldDealWrite(req, { dealId }, (db) =>
      unstarFieldProject(db, { userId: req.fieldUser!.id, userRole: req.fieldUser!.role }, dealId),
      "Project not found",
    );
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// Public share: mint an unauthenticated, 90-day, photos-only link to a SELECTED set of a project's
// photos. Photos-only / terminal-safe — this creates a public_photo_tokens row and never mutates the
// deal (works on Won/terminal projects, matching the field module's zero-deal-mutation contract). The
// token is scoped to the resolved photo ids; the public viewer + asset/download enforce that subset.
// The recipient-facing lifetime is purely this token expiry (the asset endpoint streams via our server
// and never hands out a presigned R2 URL), so it isn't bound by the 7-day presigned-URL cap.
const SHARE_LINK_TTL_MS = 90 * 24 * 60 * 60 * 1000;
const MAX_SHARE_PHOTOS = 200;

function parseSharePhotoIds(raw: unknown): string[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new AppError(400, "photoIds must be a non-empty array of photo ids.");
  }
  // Canonicalize to lowercase: assertValidUuid accepts any case, but Postgres returns uuids in
  // canonical lowercase, so we normalize here to keep the stored subset and every downstream
  // comparison (membership validation, foundIds set) consistent regardless of client casing.
  const ids = Array.from(new Set(raw.map((value) => String(value).toLowerCase())));
  if (ids.length > MAX_SHARE_PHOTOS) {
    throw new AppError(400, `A share link can include at most ${MAX_SHARE_PHOTOS} photos.`);
  }
  ids.forEach((id) => assertValidUuid(id, "photoId"));
  return ids;
}

fieldRoutes.post("/projects/:dealId/share", requireFieldContractor, async (req, res, next) => {
  try {
    const dealId = String(req.params.dealId);
    assertValidUuid(dealId, "dealId");
    const photoIds = parseSharePhotoIds(req.body?.photoIds);

    // Resolve the deal's office (cross-office, read-only), then:
    //   1. gate the deal to a FIELD-VISIBLE project (active-pipeline or Won-family, never Lost/
    //      archived) — the same predicate the field browse + report paths use, so a share link can't
    //      be minted for a deal the field app deliberately hides; and
    //   2. validate that EVERY requested photo is an active photo on THIS deal.
    const access = { userId: req.fieldUser!.id, userRole: req.fieldUser!.role };
    const { office } = await withResolvedOffice(
      "deal",
      dealId,
      async (officeDb) => {
        await assertActiveFieldProject(officeDb, access, dealId);
        await assertPhotosBelongToDeal(officeDb, dealId, photoIds);
      },
      "Project not found",
    );

    const created = await generatePublicToken({
      dealId,
      createdByUserId: req.fieldUser!.id,
      tenantId: office.id,
      photoIds,
      expiresAt: new Date(Date.now() + SHARE_LINK_TTL_MS),
    });

    res.status(201).json({
      url: publicPhotoShareUrl(req, created.rawToken),
      token: { id: created.token.id, expiresAt: created.token.expiresAt },
      photoCount: photoIds.length,
    });
  } catch (err) {
    next(err);
  }
});

// High-res DOWNLOAD urls for selected photos (single or bulk). Same access + photo-belongs-to-deal gates
// as /share, so foreign ids can't pull another project's originals. Returns self-authenticating presigned
// attachment URLs the browser can save directly.
fieldRoutes.post("/projects/:dealId/photos/download-urls", requireFieldContractor, async (req, res, next) => {
  try {
    const dealId = String(req.params.dealId);
    assertValidUuid(dealId, "dealId");
    const photoIds = parseSharePhotoIds(req.body?.photoIds);

    const { value: downloads } = await withResolvedOffice(
      "deal",
      dealId,
      (officeDb) =>
        buildFieldPhotoDownloadUrls(officeDb, {
          userId: req.fieldUser!.id,
          userRole: req.fieldUser!.role,
          dealId,
          photoIds,
          auditContext: requestAuditContext(req),
        }),
      "Project not found",
    );

    res.json({ downloads });
  } catch (err) {
    next(err);
  }
});

fieldRoutes.post("/photos/upload-url", requireFieldContractor, async (req, res, next) => {
  try {
    const target = {
      dealId: typeof req.body.dealId === "string" ? req.body.dealId : undefined,
      leadId: typeof req.body.leadId === "string" ? req.body.leadId : undefined,
      opportunityId: typeof req.body.opportunityId === "string" ? req.body.opportunityId : undefined,
    };
    const scorecardId = parseOptionalScorecardId(req.body.scorecardId);
    const clientUploadId = parseOptionalClientUploadId(req.body.clientUploadId);
    if (scorecardId && !clientUploadId) {
      throw new AppError(400, "clientUploadId is required for scorecard edit evidence.");
    }
    // The R2 key (b) is bound to the resolved office via `officeSlug: office.slug`; the deal-number
    // lookup inside requestUploadUrl runs in that same office's schema (a).
    const result = await runFieldPhotoWrite(req, target, scorecardId, (db, office) =>
      requestFieldPhotoUploadUrl(db, {
        officeSlug: office.slug,
        userId: req.fieldUser!.id,
        userRole: req.fieldUser!.role,
        ...target,
        contentType: String(req.body.contentType),
        sizeBytes: Number(req.body.sizeBytes),
        photoCategory: req.body.category ?? req.body.photoCategory ?? null,
        caption: req.body.caption ?? null,
        tags: Array.isArray(req.body.tags) ? req.body.tags.map(String) : [],
        scorecardId,
        clientUploadId,
      }),
    );
    res.json(result);
  } catch (err) {
    next(err);
  }
});

fieldRoutes.post("/photos/confirm-upload", requireFieldContractor, async (req, res, next) => {
  try {
    const target = {
      dealId: typeof req.body.dealId === "string" ? req.body.dealId : undefined,
      leadId: typeof req.body.leadId === "string" ? req.body.leadId : undefined,
      opportunityId: typeof req.body.opportunityId === "string" ? req.body.opportunityId : undefined,
    };
    const scorecardId = parseOptionalScorecardId(req.body.scorecardId);
    const clientUploadId = parseOptionalClientUploadId(req.body.clientUploadId);
    if (scorecardId && !clientUploadId) {
      throw new AppError(400, "clientUploadId is required for scorecard edit evidence.");
    }
    // job_queue.office_id (c) is bound to the resolved office via `officeId: office.id`; officeSlug lets
    // confirmFieldPhotoUpload assert the token's r2Key was minted under this same office.
    const result = await runFieldPhotoWrite(req, target, scorecardId, (db, office) =>
      confirmFieldPhotoUpload(db, {
        userId: req.fieldUser!.id,
        userRole: req.fieldUser!.role,
        officeId: office.id,
        officeSlug: office.slug,
        ...target,
        uploadToken: String(req.body.uploadToken),
        objectKey: String(req.body.objectKey),
        clientUploadId,
        scorecardId,
        latitude: req.body.latitude !== undefined ? Number(req.body.latitude) : undefined,
        longitude: req.body.longitude !== undefined ? Number(req.body.longitude) : undefined,
        addressSource: req.body.addressSource,
        takenAt: req.body.takenAt,
        auditContext: requestAuditContext(req),
      }),
    );
    res.status(201).json(result);
  } catch (err) {
    next(err);
  }
});

fieldRoutes.get("/photos/pending", ...fieldProjectMiddleware, async (req, res, next) => {
  try {
    const result = await listPendingFieldPhotos(req.tenantDb!, {
      userId: req.fieldUser!.id,
      userRole: req.fieldUser!.role,
    });
    await req.commitTransaction();
    res.json(result);
  } catch (err) {
    next(err);
  }
});

fieldRoutes.post("/photos/:photoId/assign-target", requireFieldContractor, async (req, res, next) => {
  try {
    const photoId = String(req.params.photoId);
    assertValidUuid(photoId, "photoId");
    const target = {
      dealId: typeof req.body.dealId === "string" ? req.body.dealId : undefined,
      leadId: typeof req.body.leadId === "string" ? req.body.leadId : undefined,
      opportunityId: typeof req.body.opportunityId === "string" ? req.body.opportunityId : undefined,
    };
    assertValidCaptureTargetIds(target);

    const crossOffice = isFieldCrossOfficeWritesEnabled();
    // The PENDING photo physically lives in the office it was uploaded into (unassigned uploads park in
    // the uploader's office). The chosen target must live in that SAME office — otherwise binding it is a
    // cross-schema row move, which we reject (the files.deal_id FK is the structural backstop). Direct
    // capture (select a cross-office project, then shoot) is unaffected: that row is born in the deal's
    // office via upload-url + confirm.
    const photoOffice = crossOffice
      ? await resolveWriteOffice("file", photoId, "Pending photo not found")
      : await getFieldOfficeById(req.fieldUser!.tenantId);
    if (crossOffice) {
      const targetOffice = await resolveFieldWriteOffice(req.fieldUser!.tenantId, target, "Capture target not found");
      if (targetOffice.id !== photoOffice.id) {
        throw new AppError(
          409,
          `This photo was captured under ${photoOffice.slug} and can't be reassigned to a project in ${targetOffice.slug}. Re-capture it from that project instead.`,
        );
      }
    }

    const result = await runInOfficeTransaction(photoOffice, req.fieldUser!.id, (db) =>
      assignPendingFieldPhotoTarget(db, { userId: req.fieldUser!.id, userRole: req.fieldUser!.role }, {
        photoId,
        ...target,
      }),
    );
    res.json(result);
  } catch (err) {
    next(err);
  }
});

fieldRoutes.get("/photos/transcribe-description", requireFieldContractor, (_req, res) => {
  res.json(getFieldPhotoTranscriptionConfig());
});

fieldRoutes.post("/photos/transcribe-description", requireFieldContractor, rawAudioBody(), async (req, res, next) => {
  try {
    const body = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    const result = await transcribePhotoDescriptionAudio({
      audio: body,
      mimeType: String(req.headers["content-type"] ?? ""),
      fileName: typeof req.headers["x-file-name"] === "string" ? req.headers["x-file-name"] : undefined,
    });
    res.json(result);
  } catch (err) {
    next(err);
  }
});

fieldRoutes.post("/photos/:photoId/transcribe-description", requireFieldContractor, rawAudioBody(), async (req, res, next) => {
  try {
    const photoId = String(req.params.photoId);
    const body = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    const result = await runFieldFileWrite(req, photoId, (db) =>
      transcribeAndPersistFieldPhotoDescription(db, {
        userId: req.fieldUser!.id,
        userRole: req.fieldUser!.role,
      }, {
        photoId,
        audio: body,
        mimeType: String(req.headers["content-type"] ?? ""),
        fileName: typeof req.headers["x-file-name"] === "string" ? req.headers["x-file-name"] : undefined,
        auditContext: requestAuditContext(req),
      }),
    );
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// Field-auth edit of an already-uploaded photo's display name / description. Session PATCH /files/:id is
// unreachable from field Bearer auth, and the only field text-edit route is audio transcription — camera
// captures land as system names, so this is the field rename/describe point. Rep-owned via
// getAccessibleFieldPhoto; audits caption_changed on a description change (parity with the web route).
fieldRoutes.patch("/photos/:photoId", requireFieldContractor, async (req, res, next) => {
  try {
    const photoId = String(req.params.photoId);
    const result = await runFieldFileWrite(req, photoId, (db) =>
      updateFieldPhotoMetadata(
        db,
        { userId: req.fieldUser!.id, userRole: req.fieldUser!.role },
        {
          photoId,
          displayName: typeof req.body.displayName === "string" ? req.body.displayName : undefined,
          description:
            req.body.description === null
              ? null
              : typeof req.body.description === "string"
                ? req.body.description
                : undefined,
          auditContext: requestAuditContext(req),
        },
      ),
    );
    res.json(result);
  } catch (err) {
    next(err);
  }
});

fieldRoutes.post("/photos/:photoId/tags", requireFieldContractor, async (req, res, next) => {
  try {
    const photoId = String(req.params.photoId);
    const result = await runFieldFileWrite(req, photoId, (db) =>
      replaceFieldPhotoTags(db, {
        userId: req.fieldUser!.id,
        userRole: req.fieldUser!.role,
      }, {
        photoId,
        tags: Array.isArray(req.body.tags) ? req.body.tags.map(String) : [],
      }),
    );
    res.json(result);
  } catch (err) {
    next(err);
  }
});

fieldRoutes.delete("/photos/:photoId/tags/:tag", requireFieldContractor, async (req, res, next) => {
  try {
    const photoId = String(req.params.photoId);
    const result = await runFieldFileWrite(req, photoId, (db) =>
      deleteFieldPhotoTag(db, {
        userId: req.fieldUser!.id,
        userRole: req.fieldUser!.role,
      }, {
        photoId,
        tag: decodeURIComponent(String(req.params.tag)),
      }),
    );
    res.json(result);
  } catch (err) {
    next(err);
  }
});

fieldRoutes.get("/projects/:dealId/tags", requireFieldContractor, async (req, res, next) => {
  try {
    const access = { userId: req.fieldUser!.id, userRole: req.fieldUser!.role };
    const projectId = String(req.params.dealId);
    const { value, office } = await withResolvedOffice(
      "deal",
      projectId,
      (officeDb) =>
        searchFieldProjectTags(officeDb, access, {
          projectId,
          query: typeof req.query.q === "string" ? req.query.q : undefined,
          limit: req.query.limit ? parseOptionalPositiveInt(req.query.limit) : undefined,
        }),
      "Project not found",
    );
    res.json({ ...value, ...officeTag(office) });
  } catch (err) {
    next(err);
  }
});

fieldRoutes.get("/projects/:dealId/reports", requireFieldContractor, async (req, res, next) => {
  try {
    const access = { userId: req.fieldUser!.id, userRole: req.fieldUser!.role };
    const dealId = String(req.params.dealId);
    const { value, office } = await withResolvedOffice(
      "deal",
      dealId,
      (officeDb) => listFieldProjectReports(officeDb, access, dealId),
      "Project not found",
    );
    res.json({ ...value, ...officeTag(office) });
  } catch (err) {
    next(err);
  }
});

// The deal's assigned Superintendent + PM NAMES, for the mobile scorecard header prefill. Field-scoped
// (surface:"field") so T-Rock Cam can actually reach it — the CRM /deals/:id/team route rejects the field
// surface. Read-only, resolves the deal's owning office like the other field project routes, and gates on
// the deal being a browsable field project before returning names. Names come from the ACTIVE
// superintendent/project_manager team rows with ACTIVE user/contact identities (shared resolver with the
// scorecard-email CC), so the prefilled name is the same person the completed-scorecard email is sent to.
fieldRoutes.get("/projects/:dealId/team", requireFieldContractor, async (req, res, next) => {
  try {
    const access = { userId: req.fieldUser!.id, userRole: req.fieldUser!.role };
    const dealId = String(req.params.dealId);
    assertValidUuid(dealId, "dealId");
    const { value } = await withResolvedOffice(
      "deal",
      dealId,
      async (officeDb) => {
        // Gate to a browsable field project first (mirrors the other field project routes), so this can't
        // leak team names for a deal the field app deliberately hides.
        await assertActiveFieldProject(officeDb, access, dealId);
        return resolveScorecardTeamNames(officeDb, dealId);
      },
      "Project not found",
    );
    res.json({ superintendentName: value.superintendentName, pmName: value.pmName });
  } catch (err) {
    next(err);
  }
});

fieldRoutes.get("/reports/:reportId/download", requireFieldContractor, async (req, res, next) => {
  try {
    const access = { userId: req.fieldUser!.id, userRole: req.fieldUser!.role };
    const reportId = String(req.params.reportId);
    const { value, office } = await withResolvedOffice(
      "file",
      reportId,
      (officeDb) => getFieldProjectReportDownload(officeDb, access, reportId),
      "Report not found",
    );
    res.json({ ...value, ...officeTag(office) });
  } catch (err) {
    next(err);
  }
});

fieldRoutes.post("/reports/preview", requireFieldContractor, async (req, res, next) => {
  try {
    const projectId = String(req.body.projectId);
    const result = await runFieldDealWrite(req, { dealId: projectId }, (db) =>
      previewFieldPhotoReport(db, {
        userId: req.fieldUser!.id,
        userRole: req.fieldUser!.role,
      }, {
        projectId,
        photoIds: Array.isArray(req.body.photoIds) ? req.body.photoIds.map(String) : [],
        groupBy: req.body.groupBy === "tag" || req.body.groupBy === "date" ? req.body.groupBy : "none",
        creatorName: [req.fieldUser!.firstName, req.fieldUser!.lastName].filter(Boolean).join(" ") || req.fieldUser!.email,
      }),
      "Project not found",
    );
    res.json(result);
  } catch (err) {
    next(err);
  }
});

fieldRoutes.post("/reports/generate", requireFieldContractor, async (req, res, next) => {
  try {
    const projectId = String(req.body.projectId);
    const result = await runFieldDealWrite(req, { dealId: projectId }, (db, office) =>
      generateFieldPhotoReport(db, {
        userId: req.fieldUser!.id,
        userRole: req.fieldUser!.role,
      }, {
        officeSlug: office.slug,
        projectId,
      reportTitle: String(req.body.reportTitle ?? ""),
      executiveSummary: req.body.executiveSummary == null ? null : String(req.body.executiveSummary),
      coverData: {
        creatorName: String(req.body.coverData?.creatorName ?? ""),
        companyName: req.body.coverData?.companyName ?? null,
        reportDateLabel: req.body.coverData?.reportDateLabel ?? null,
        projectName: req.body.coverData?.projectName ?? null,
      },
      sections: Array.isArray(req.body.sections)
        ? req.body.sections.map((section: any) => ({
            title: String(section?.title ?? ""),
            photoIds: Array.isArray(section?.photoIds) ? section.photoIds.map(String) : [],
            photoOverrides: Array.isArray(section?.photoOverrides)
              ? section.photoOverrides.map((entry: any) => ({
                  id: String(entry?.id),
                  description: entry?.description == null ? null : String(entry.description),
                }))
              : [],
          }))
        : [],
      }),
      "Project not found",
    );
    res.status(201).json(result);
  } catch (err) {
    next(err);
  }
});

// The capture-target picker feeds the photo-ATTACH (write) flow. It goes cross-office IN LOCKSTEP with
// the writes (gated on the same flag): flag-on surfaces every active office's targets (so a user can
// attach to a project in any office the now-cross-office write path can reach); flag-off stays single
// office (uploader's), so it never surfaces a target the single-office upload can't write to.
fieldRoutes.get("/photo-targets/search", requireFieldContractor, async (req, res, next) => {
  try {
    const access = { userId: req.fieldUser!.id, userRole: req.fieldUser!.role };
    const search = req.query.search as string | undefined;
    const limit = parseOptionalPositiveInt(req.query.limit);
    // Scorecard picker: filter to deals server-side (before the caps) so a lead/opportunity-heavy result
    // set can't starve out matching deals.
    const dealsOnly = req.query.dealsOnly === "true";

    if (!isFieldCrossOfficeWritesEnabled()) {
      const office = await getFieldOfficeById(req.fieldUser!.tenantId);
      const result = await runInOffice(office, (db) => searchFieldCaptureTargets(db, access, { search, limit, dealsOnly }));
      res.json(result);
      return;
    }

    const globalLimit = limit ?? FIELD_CAPTURE_TARGET_DEFAULT_LIMIT;
    const { results, failures } = assertFanOutNotFullyDegraded(
      await fanOutActiveOffices((db) => searchFieldCaptureTargets(db, access, { search, limit: globalLimit, dealsOnly })),
    );
    const targets = mergeFieldCaptureTargets(
      results.map(({ office, value }) => ({ office, targets: value.targets })),
      globalLimit,
    );
    res.json({ targets, degradedOffices: failures.map((failure) => failure.office.slug) });
  } catch (err) {
    next(err);
  }
});

fieldRoutes.get("/photo-targets/nearby", requireFieldContractor, async (req, res, next) => {
  try {
    const access = { userId: req.fieldUser!.id, userRole: req.fieldUser!.role };
    const latitude = parseRequiredCoordinate(req.query.lat, "lat", -90, 90);
    const longitude = parseRequiredCoordinate(req.query.lng, "lng", -180, 180);
    const limit = req.query.limit ? parseOptionalPositiveInt(req.query.limit) : 3;

    if (!isFieldCrossOfficeWritesEnabled()) {
      const office = await getFieldOfficeById(req.fieldUser!.tenantId);
      const result = await runInOffice(office, (db) =>
        listNearbyFieldCaptureTargets(db, access, { latitude, longitude, limit }),
      );
      res.json(result);
      return;
    }

    const globalLimit = limit ?? 3;
    const { results, failures } = assertFanOutNotFullyDegraded(
      await fanOutActiveOffices((db) => listNearbyFieldCaptureTargets(db, access, {
        latitude,
        longitude,
        limit: globalLimit,
      })),
    );
    const targets = results.flatMap(({ office, value }) =>
      value.targets.map((target) => ({ ...target, ...officeTag(office) })),
    );
    targets.sort((left, right) => {
      const distanceDelta = left.distanceMiles - right.distanceMiles;
      if (distanceDelta !== 0) return distanceDelta;
      return left.id.localeCompare(right.id);
    });
    res.json({
      targets: targets.slice(0, globalLimit),
      degradedOffices: failures.map((failure) => failure.office.slug),
    });
  } catch (err) {
    next(err);
  }
});

fieldRoutes.get("/photo-targets/validate", requireFieldContractor, async (req, res, next) => {
  try {
    const access = { userId: req.fieldUser!.id, userRole: req.fieldUser!.role };
    const target = {
      dealId: typeof req.query.dealId === "string" ? req.query.dealId : undefined,
      leadId: typeof req.query.leadId === "string" ? req.query.leadId : undefined,
      opportunityId: typeof req.query.opportunityId === "string" ? req.query.opportunityId : undefined,
    };
    assertValidCaptureTargetIds(target);
    const office = await resolveFieldWriteOffice(req.fieldUser!.tenantId, target);
    const result = await runInOffice(office, (db) =>
      assertAccessibleFieldCaptureTarget(db, { ...access, ...target }),
    );
    // Stamp the owning office only when cross-office writes are on — keeps the flag-off payload contract
    // byte-for-byte identical to today's single-office response (`{ target }`).
    res.json(isFieldCrossOfficeWritesEnabled() ? { target: result, ...officeTag(office) } : { target: result });
  } catch (err) {
    next(err);
  }
});

fieldRoutes.get("/projects/:dealId/photos", requireFieldContractor, async (req, res, next) => {
  try {
    const access = { userId: req.fieldUser!.id, userRole: req.fieldUser!.role };
    const dealId = String(req.params.dealId);
    const categories = typeof req.query.category === "string" && req.query.category.length > 0
      ? req.query.category.split(",")
      : undefined;
    const uploaderIds = typeof req.query.uploader === "string" && req.query.uploader.length > 0
      ? req.query.uploader.split(",")
      : undefined;
    // Parse defensively: parseInt of a non-numeric value is NaN, which must NOT flow downstream into the
    // limit/offset math — fall back to default (page 1, perPage undefined → service default).
    const pageRaw = parseInt(req.query.page as string, 10);
    const page = Number.isFinite(pageRaw) ? Math.max(1, pageRaw) : 1;
    const perPageRaw = parseInt(req.query.perPage as string, 10);
    const perPage = Number.isFinite(perPageRaw) ? perPageRaw : undefined;
    const { value, office } = await withResolvedOffice(
      "deal",
      dealId,
      (officeDb) =>
        listFieldProjectPhotos(officeDb, access, dealId, {
          categories,
          uploaderIds,
          from: req.query.from as string | undefined,
          to: req.query.to as string | undefined,
          includeDeleted: false,
        }, { page, perPage }),
      "Project not found",
    );
    res.json({ ...value, ...officeTag(office) });
  } catch (err) {
    next(err);
  }
});

// ── Field Scorecards ─────────────────────────────────────────────────────────

function scorecardSubmitterName(user: NonNullable<express.Request["fieldUser"]>): string | null {
  const name = [user.firstName, user.lastName].filter((s) => s && s.trim()).join(" ").trim();
  return name || user.email || null;
}

// Submit a weekly scorecard. Writes run in the deal's owning office when the cross-office write flag is
// on, else the submitter's active office (mirrors photo capture; off-office projects are view-only). The
// service gates on the deal being a browsable field project, recomputes total/rating, enforces the
// action-item gate, and is idempotent on clientSubmissionId so a durable offline retry never duplicates.
fieldRoutes.post("/scorecards", requireFieldContractor, async (req, res, next) => {
  try {
    const parsed = parseScorecardSubmission(req.body);
    const submittedByName = scorecardSubmitterName(req.fieldUser!);
    let resolvedOffice: FieldOffice | undefined;
    const { scorecard, created } = await runFieldDealWrite(
      req,
      { dealId: parsed.dealId },
      (db, office) => {
        resolvedOffice = office;
        return createFieldScorecard(db, {
          userId: req.fieldUser!.id,
          userRole: req.fieldUser!.role,
          submittedByName,
          office: { id: office.id, slug: office.slug },
          ...parsed,
        });
      },
      "Project not found",
    );
    // Respond as soon as the submission is durably committed — the PDF render + email happen post-commit so
    // an R2/email hiccup can never lose (or block) the submission, and the mobile submit stays snappy.
    res.status(created ? 201 : 200).json({ scorecard });
    if (created && resolvedOffice) {
      const office = resolvedOffice;
      // Best-effort: enqueue the email (durable) + render/store the PDF. Manages its own connections and
      // enqueues BEFORE the best-effort render, so a PDF/R2 failure can't drop the notification. A throw
      // must not surface to the client — the scorecard is already saved.
      void finalizeFieldScorecardArtifacts(office, req.fieldUser!.id, scorecard.id).catch((err) => {
        console.error("[field-scorecard] PDF/email finalize failed (submission is saved)", {
          scorecardId: scorecard.id,
          office: office.slug,
          err,
        });
      });
    }
    return;
  } catch (err) {
    next(err);
  }
});

// Recent submitted scorecards across ALL active offices — powers the Scorecard tab landing (which has no
// pre-selected project). Field reads are intentionally office-agnostic (view-only), like /projects; each
// per-office query is gated to browsable projects. Registered before /scorecards/:id.
fieldRoutes.get("/scorecards", requireFieldContractor, async (req, res, next) => {
  try {
    const limitRaw = parseInt(req.query.limit as string, 10);
    const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(limitRaw, 1), 200) : 50;
    const { results, failures } = assertFanOutNotFullyDegraded(
      await fanOutActiveOffices((officeDb) =>
        listRecentFieldScorecards(officeDb, { limit, viewerUserId: req.fieldUser!.id }),
      ),
    );
    const scorecards = results
      .flatMap(({ office, value }) => value.scorecards.map((s) => ({ ...s, ...officeTag(office) })))
      .sort((a, b) => (b.submittedAt ?? "").localeCompare(a.submittedAt ?? ""))
      .slice(0, limit);
    res.json({ scorecards, degradedOffices: failures.map((failure) => failure.office.slug) });
  } catch (err) {
    next(err);
  }
});

// Discard cleanup for a submitted-card edit whose new evidence may already have confirmed before a 409.
// Resolve by immutable scorecard id (like PUT), then let the service enforce exact submitter/deal ownership
// and preserve anything that another successful request already linked to a scorecard.
fieldRoutes.post("/scorecards/:id/discard-edit-evidence", requireFieldContractor, async (req, res, next) => {
  try {
    const id = String(req.params.id);
    assertValidUuid(id, "id");
    const clientUploadIds = parseScorecardDiscardEvidenceIds(req.body?.clientUploadIds);
    const office = await resolveWriteOffice("scorecard", id, "Scorecard not found");
    const result = await runInOfficeTransaction(office, req.fieldUser!.id, (db) =>
      discardScorecardEditEvidence(db, {
        scorecardId: id,
        userId: req.fieldUser!.id,
        clientUploadIds,
      }),
    );
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// Full replacement of a submitted current-form scorecard's editable content. Unlike a new submission,
// this write always resolves by SCORECARD id (independent of the cross-office-write feature flag): the row
// already has one authoritative owning schema. The service enforces exact submittedBy UUID ownership with
// no admin/director override, derives immutable deal/kind/version/week fields from that row, and applies an
// optimistic updatedAt token before replacing content.
fieldRoutes.put("/scorecards/:id", requireFieldContractor, async (req, res, next) => {
  try {
    const id = String(req.params.id);
    assertValidUuid(id, "id");
    const parsed = parseScorecardUpdate(req.body);
    const office = await resolveWriteOffice("scorecard", id, "Scorecard not found");
    const result = await runInOfficeTransaction(office, req.fieldUser!.id, (db) =>
      updateFieldScorecard(db, {
        userId: req.fieldUser!.id,
        userRole: req.fieldUser!.role,
        scorecardId: id,
        office,
        ...parsed,
      }),
    );

    // The edit is durable once the office transaction returns. Regenerate the immutable PDF after the
    // response just like create: storage/transcode failures must not roll back or hide the successful edit.
    res.json(result);
    void finalizeFieldScorecardArtifacts(office, req.fieldUser!.id, id).catch((err) => {
      console.error("[field-scorecard] PDF finalize failed after edit (edit is saved)", {
        scorecardId: id,
        office: office.slug,
        err,
      });
    });
    return;
  } catch (err) {
    next(err);
  }
});

// Full detail of one scorecard (items, deficiencies, action items, evidence photos w/ presigned URLs).
// Resolves the owning office by scorecard id, so it works even off the active x-office-id.
fieldRoutes.get("/scorecards/:id", requireFieldContractor, async (req, res, next) => {
  try {
    const id = String(req.params.id);
    assertValidUuid(id, "id");
    const { value, office } = await withResolvedOffice(
      "scorecard",
      id,
      (officeDb) =>
        getFieldScorecardDetail(
          officeDb,
          id,
          { userId: req.fieldUser!.id, userRole: req.fieldUser!.role },
          {
            resolvePhotoUrl: (fileId) =>
              getFileDownloadUrl(officeDb, fileId)
                .then((r) => r.url)
                .catch(() => null),
          },
        ),
      "Scorecard not found",
    );
    res.json({ scorecard: { ...value, ...officeTag(office) } });
  } catch (err) {
    next(err);
  }
});

// Presigned download for a scorecard's rendered PDF. Resolve + authorize inside the owning-office read,
// then release that connection before any R2 work. Missing/legacy artifacts are regenerated on demand so
// pre-evidence PDFs are upgraded the first time someone downloads them.
fieldRoutes.get("/scorecards/:id/download", requireFieldContractor, async (req, res, next) => {
  try {
    const id = String(req.params.id);
    assertValidUuid(id, "id");
    const { value: artifact, office } = await withResolvedOffice(
      "scorecard",
      id,
      (officeDb) =>
        getFieldScorecardPdfArtifactState(officeDb, id, {
          userId: req.fieldUser!.id,
          userRole: req.fieldUser!.role,
        }),
      "Scorecard not found",
    );
    let pdfR2Key = artifact.pdfR2Key;
    const storedObjectAvailable = artifact.needsRegeneration
      ? false
      : await isStoredScorecardPdfAvailable(pdfR2Key);
    if (artifact.needsRegeneration || !storedObjectAvailable) {
      try {
        pdfR2Key = await finalizeFieldScorecardArtifacts(office, req.fieldUser!.id, id);
      } catch (err) {
        if (err instanceof AppError) throw err;
        console.error("[FieldScorecardPDF] On-demand regeneration failed", { scorecardId: id, err });
        throw new AppError(
          503,
          "The scorecard PDF could not be refreshed. Please try again shortly.",
          "SCORECARD_PDF_REGENERATION_FAILED",
        );
      }
      if (!pdfR2Key || !(await isStoredScorecardPdfAvailable(pdfR2Key))) {
        throw new AppError(
          503,
          "The refreshed scorecard PDF is not available yet. Please try again shortly.",
          "SCORECARD_PDF_NOT_READY",
        );
      }
    }
    if (!pdfR2Key) throw new AppError(503, "The scorecard PDF is not available yet. Please try again shortly.");
    const value = await presignFieldScorecardPdf(id, pdfR2Key);
    res.json(value);
  } catch (err) {
    next(err);
  }
});

// Scorecards for one project (project-detail list + post-submit refresh).
fieldRoutes.get("/projects/:dealId/scorecards", requireFieldContractor, async (req, res, next) => {
  try {
    const dealId = String(req.params.dealId);
    assertValidUuid(dealId, "dealId");
    const { value, office } = await withResolvedOffice(
      "deal",
      dealId,
      (officeDb) =>
        listFieldScorecardsForProject(officeDb, { userId: req.fieldUser!.id, userRole: req.fieldUser!.role }, dealId),
      "Project not found",
    );
    res.json({ ...value, ...officeTag(office) });
  } catch (err) {
    next(err);
  }
});
