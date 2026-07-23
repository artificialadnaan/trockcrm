import type { ApiFetchOptions } from "./client";
import type {
  AuthResponse,
  InvitePreview,
  ProjectsResponse,
  StarredProjectsResponse,
  NearbyProjectsResponse,
  StarResponse,
  PhotosResponse,
  PendingPhotosResponse,
  ConfirmUploadRequest,
  ConfirmUploadResponse,
  AssignTargetResponse,
  TagsResponse,
  ProjectTagsResponse,
  UploadUrlRequest,
  UploadUrlResponse,
  CaptureTargetsResponse,
  ValidateTargetResponse,
  TranscribeConfig,
  ReportGroupBy,
  ReportPreviewResponse,
  GenerateReportRequest,
  GenerateReportResponse,
  ReportsResponse,
  ReportDownloadResponse,
  ShareLinkResponse,
  CreateScorecardResponse,
  UpdateScorecardResponse,
  RecentScorecardsResponse,
  ProjectScorecardsResponse,
  ScorecardDetailResponse,
  ScorecardDownloadResponse,
  DealTeamResponse,
  CorrectiveActionsResponse,
  CorrectiveActionUploadUrlResponse,
  CorrectiveActionConfirmUploadResponse,
} from "./types";
import type { ScorecardSubmissionPayload, ScorecardUpdatePayload } from "../scorecards/draft";

/**
 * A `Fetcher` is `apiFetch` already bound to the current token / officeId /
 * onUnauthorized at the call site (see AuthContext.fetcher). Endpoint fns stay
 * pure and injectable so they can be unit-tested with a stub fetcher.
 */
export type Fetcher = <T = unknown>(
  path: string,
  opts?: Omit<ApiFetchOptions, "token" | "officeId" | "onUnauthorized">,
) => Promise<T>;

// ── Auth (public; the fetcher simply omits Authorization when there's no token) ─
export const login = (f: Fetcher, email: string, password: string) =>
  f<AuthResponse>("/auth/field-login", { method: "POST", body: { email, password } });

export const acceptInvite = (f: Fetcher, token: string, password: string) =>
  f<AuthResponse>("/auth/accept-invite", { method: "POST", body: { token, password } });

export const previewInvite = (f: Fetcher, token: string) =>
  f<InvitePreview>("/auth/invite-preview", { query: { token } });

export const logout = (f: Fetcher) => f<void>("/auth/logout", { method: "POST" });

export const getMe = (f: Fetcher) => f<{ user: AuthResponse["user"] }>("/field/me");

// ── Projects ──────────────────────────────────────────────────────────────────
export const getProjects = (f: Fetcher, params: { search?: string; status?: string; page?: number; perPage?: number }) =>
  f<ProjectsResponse>("/field/projects", { query: { status: "active", ...params } });

export const getStarredProjects = (f: Fetcher) =>
  f<StarredProjectsResponse>("/field/projects/starred");

// The 3 active projects closest to the device. Server fans out across offices and returns the true
// nearest 3 overall, each carrying `distanceMiles`.
export const getNearbyProjects = (f: Fetcher, lat: number, lng: number) =>
  f<NearbyProjectsResponse>("/field/projects/nearby", { query: { lat, lng } });

export const starProject = (f: Fetcher, dealId: string) =>
  f<StarResponse>(`/field/projects/${dealId}/star`, { method: "POST" });

export const unstarProject = (f: Fetcher, dealId: string) =>
  f<StarResponse>(`/field/projects/${dealId}/star`, { method: "DELETE" });

// ── Photos / gallery ──────────────────────────────────────────────────────────
export const getProjectPhotos = (
  f: Fetcher,
  dealId: string,
  params?: { category?: string; uploader?: string; from?: string; to?: string; page?: number; perPage?: number },
) => f<PhotosResponse>(`/field/projects/${dealId}/photos`, { query: params });

// Mint an unauthenticated, 7-day public link to the SELECTED photos (photos-only; never mutates the
// deal). Server contract: 201 { url, token: { id, expiresAt }, photoCount }.
export const shareProjectPhotos = (
  f: Fetcher,
  dealId: string,
  body: { photoIds: string[] },
) => f<ShareLinkResponse>(`/field/projects/${dealId}/share`, { method: "POST", body });

export const getPendingPhotos = (f: Fetcher) => f<PendingPhotosResponse>("/field/photos/pending");

export const assignPhotoTarget = (
  f: Fetcher,
  photoId: string,
  target: { dealId?: string; leadId?: string; opportunityId?: string },
) => f<AssignTargetResponse>(`/field/photos/${photoId}/assign-target`, { method: "POST", body: target });

export const createUploadUrl = (f: Fetcher, body: UploadUrlRequest) =>
  f<UploadUrlResponse>("/field/photos/upload-url", { method: "POST", body });

export const confirmUpload = (f: Fetcher, body: ConfirmUploadRequest) =>
  f<ConfirmUploadResponse>("/field/photos/confirm-upload", { method: "POST", body });

export const replacePhotoTags = (f: Fetcher, photoId: string, tags: string[]) =>
  f<TagsResponse>(`/field/photos/${photoId}/tags`, { method: "POST", body: { tags } });

export const updatePhotoMetadata = (
  f: Fetcher,
  photoId: string,
  body: { displayName?: string; description?: string | null },
) => f<{ photo: unknown }>(`/field/photos/${photoId}`, { method: "PATCH", body });

export const getProjectTags = (f: Fetcher, dealId: string, q: string, limit = 8) =>
  f<ProjectTagsResponse>(`/field/projects/${dealId}/tags`, { query: { q, limit } });

// ── Capture targets ───────────────────────────────────────────────────────────
export const searchCaptureTargets = (f: Fetcher, search: string, limit = 20, dealsOnly = false) =>
  f<CaptureTargetsResponse>("/field/photo-targets/search", {
    // dealsOnly filters to deals server-side (before the result cap) for the scorecard picker.
    query: { search, limit, ...(dealsOnly ? { dealsOnly: "true" } : {}) },
  });

export const getNearbyCaptureTargets = (
  f: Fetcher,
  params: { latitude: number; longitude: number; limit?: number },
) =>
  f<CaptureTargetsResponse>("/field/photo-targets/nearby", {
    query: { lat: params.latitude, lng: params.longitude, limit: params.limit ?? 3 },
  });

export const validateCaptureTarget = (
  f: Fetcher,
  target: { dealId?: string; leadId?: string; opportunityId?: string },
) => f<ValidateTargetResponse>("/field/photo-targets/validate", { query: target });

// ── Voice transcription (config probe; the audio POST uses uploadAsync, not this) ─
export const getTranscriptionConfig = (f: Fetcher) =>
  f<TranscribeConfig>("/field/photos/transcribe-description");

// ── Reports ───────────────────────────────────────────────────────────────────
export const previewReport = (
  f: Fetcher,
  body: { projectId: string; photoIds: string[]; groupBy: ReportGroupBy },
) => f<ReportPreviewResponse>("/field/reports/preview", { method: "POST", body });

export const generateReport = (f: Fetcher, body: GenerateReportRequest) =>
  f<GenerateReportResponse>("/field/reports/generate", { method: "POST", body });

export const getProjectReports = (f: Fetcher, dealId: string) =>
  f<ReportsResponse>(`/field/projects/${dealId}/reports`);

export const getReportDownload = (f: Fetcher, reportId: string) =>
  f<ReportDownloadResponse>(`/field/reports/${reportId}/download`);

// ── Field Scorecards ────────────────────────────────────────────────────────
export const createScorecard = (f: Fetcher, body: ScorecardSubmissionPayload) =>
  f<CreateScorecardResponse>("/field/scorecards", { method: "POST", body });

export const updateScorecard = (f: Fetcher, id: string, body: ScorecardUpdatePayload) =>
  f<UpdateScorecardResponse>(`/field/scorecards/${id}`, { method: "PUT", body });

const SCORECARD_EDIT_DISCARD_CHUNK = 100;

/**
 * Reconcile an append-only edit ledger without assuming it can never exceed the scorecard's current
 * 100-photo limit. Repeated replace/retry cycles can accumulate more ids, so send bounded sequential
 * chunks and only let the caller delete its local draft after every chunk succeeds.
 */
export async function discardScorecardEditEvidence(
  f: Fetcher,
  id: string,
  clientUploadIds: string[],
): Promise<{ discarded: number }> {
  let discarded = 0;
  for (let offset = 0; offset < clientUploadIds.length; offset += SCORECARD_EDIT_DISCARD_CHUNK) {
    const result = await f<{ discarded: number }>(`/field/scorecards/${id}/discard-edit-evidence`, {
      method: "POST",
      body: { clientUploadIds: clientUploadIds.slice(offset, offset + SCORECARD_EDIT_DISCARD_CHUNK) },
    });
    discarded += result.discarded;
  }
  return { discarded };
}

// Recent submitted cards across accessible offices — the Scorecard tab landing.
export const getRecentScorecards = (f: Fetcher, limit = 50) =>
  f<RecentScorecardsResponse>("/field/scorecards", { query: { limit } });

export const getProjectScorecards = (f: Fetcher, dealId: string) =>
  f<ProjectScorecardsResponse>(`/field/projects/${dealId}/scorecards`);

export const getScorecard = (f: Fetcher, id: string) =>
  f<ScorecardDetailResponse>(`/field/scorecards/${id}`);

// Presigned PDF for a submitted scorecard. 404s while the PDF is still generating — the caller
// (view/[id].tsx) turns that into a "still generating" toast rather than a crash.
export const getScorecardDownload = (f: Fetcher, id: string) =>
  f<ScorecardDownloadResponse>(`/field/scorecards/${id}/download`);

// ── Corrective actions ────────────────────────────────────────────────────────
// Read a below-band scorecard's corrective-action items + their inline responses. Session auth in-app
// (the server also admits a ?token for the email-only web responder, unused here). Returns { items }.
export const getCorrectiveActions = (f: Fetcher, scorecardId: string) =>
  f<CorrectiveActionsResponse>(`/field/scorecards/${scorecardId}/corrective-actions`);

// Submit a per-item response (comment + already-uploaded response-photo file ids). The server links the
// photos, marks the item resolved, auto-closes the scorecard on the last open item, and returns the
// refreshed { items } list.
export const submitCorrectiveActionResponse = (
  f: Fetcher,
  scorecardId: string,
  itemId: string,
  body: { comment: string; photoFileIds?: string[] },
) =>
  f<CorrectiveActionsResponse>(`/field/scorecards/${scorecardId}/corrective-actions/${itemId}`, {
    method: "POST",
    // Omit photoFileIds entirely when absent so a comment-only response sends a minimal body (matches the
    // server's optional parse — [] and undefined are equivalent there, but omitting keeps the wire clean).
    body: body.photoFileIds ? { comment: body.comment, photoFileIds: body.photoFileIds } : { comment: body.comment },
  });

// Step 1 (presign) of the SCORECARD-SCOPED corrective-action response-photo upload. Unlike the generic
// /field/photos/upload-url (which lands the file in the UPLOADER'S active office), this route resolves the
// SCORECARD'S owning office, so the returned fileId exists in the same tenant the response POST reads — the
// only correct path for an assigned responder working an off-office project. Mirrors the web responder's
// requestCorrectiveActionUploadUrl contract. Returns { uploadUrl, objectKey, uploadToken, expiresIn }.
export const requestCorrectiveActionUploadUrl = (
  f: Fetcher,
  scorecardId: string,
  body: { contentType: string; sizeBytes: number },
) =>
  f<CorrectiveActionUploadUrlResponse>(`/field/scorecards/${scorecardId}/corrective-actions/upload/url`, {
    method: "POST",
    body: { contentType: body.contentType, sizeBytes: body.sizeBytes },
  });

// Step 2 (confirm) of the scorecard-scoped upload — creates the files row on the scorecard's deal (in the
// scorecard's office) and returns the fresh { fileId } the response POST's photoFileIds expects. An optional
// `caption` is persisted to files.description so a description typed in PhotoCaptionEditor survives to the
// resolved view (the read sources per-photo captions from files.description). Omitted when blank.
//
// Capture provenance (takenAt / latitude / longitude / addressSource) is threaded through the SAME field
// names as the ordinary field-photo confirm (see confirmUpload), so the server records real capture-time +
// location on the response file rather than nulls. Each field is sent only when present.
//
// `clientUploadId` is a STABLE per-photo idempotency key (the captured photo's own clientUploadId, unchanged
// across a retry of the same photo). The server threads it into confirmUpload, which dedups on it — so a
// lost-response retry with the SAME clientUploadId returns the already-created file row instead of failing on
// an expired upload token. Omitted when absent.
export const confirmCorrectiveActionUpload = (
  f: Fetcher,
  scorecardId: string,
  body: {
    uploadToken: string;
    objectKey: string;
    caption?: string | null;
    clientUploadId?: string;
    takenAt?: string;
    latitude?: number;
    longitude?: number;
    addressSource?: "exif" | "live_gps";
  },
) =>
  f<CorrectiveActionConfirmUploadResponse>(`/field/scorecards/${scorecardId}/corrective-actions/upload`, {
    method: "POST",
    body: {
      uploadToken: body.uploadToken,
      objectKey: body.objectKey,
      ...(body.caption != null ? { caption: body.caption } : {}),
      ...(body.clientUploadId != null ? { clientUploadId: body.clientUploadId } : {}),
      ...(body.takenAt != null ? { takenAt: body.takenAt } : {}),
      ...(body.latitude != null ? { latitude: body.latitude } : {}),
      ...(body.longitude != null ? { longitude: body.longitude } : {}),
      ...(body.addressSource != null ? { addressSource: body.addressSource } : {}),
    },
  });

// Discard a corrective-action response photo that was uploaded (presign → PUT → confirm creates a persistent
// files row on the scorecard's deal) but NOT yet attached to a submitted response. Used to reclaim orphans
// when a concurrent upload batch partially fails (the succeeded fileIds are discarded before the retry) or
// when the response POST 409s as CORRECTIVE_ACTION_ALREADY_RESOLVED (the uploads never attached). The server
// only deletes an eligible file (this scorecard's deal + corrective-action flow + not yet attached); an
// already-attached/absent file is a 404/409 no-op. Best-effort — callers should not block the UI on it.
export const discardCorrectiveActionPhoto = (f: Fetcher, scorecardId: string, fileId: string) =>
  f<{ discarded: boolean }>(`/field/scorecards/${scorecardId}/corrective-actions/upload/${fileId}`, {
    method: "DELETE",
  });

// The deal's assigned Superintendent + PM NAMES — used ONLY to best-effort pre-fill a new scorecard's
// header. FIELD-scoped route (/field/...): T-Rock Cam authenticates with surface:"field", which CRM auth
// rejects on /deals routes, so the old /deals/:id/team could never be reached from the app — this field
// route can. Any failure (network, timeout, a non-browsable deal) is swallowed by the caller and the names
// simply stay empty, as they were before.
export const getDealTeam = (f: Fetcher, dealId: string) =>
  f<DealTeamResponse>(`/field/projects/${dealId}/team`);
