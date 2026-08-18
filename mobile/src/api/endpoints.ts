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
  AiReportStartResponse,
  AiReportStatusResponse,
  ShareLinkResponse,
  CreateScorecardResponse,
  UpdateScorecardResponse,
  RecentScorecardsResponse,
  ProjectScorecardsResponse,
  ScorecardDetailResponse,
  ScorecardDownloadResponse,
  DealTeamResponse,
  FieldRespondersResponse,
  CorrectiveActionsResponse,
  CorrectiveActionUploadUrlResponse,
  CorrectiveActionConfirmUploadResponse,
  WeeklyReportAssignmentsResponse,
  WeeklyReportDetailResponse,
  WeeklyReportDictationResponse,
  WeeklyReportPhotoCandidatesResponse,
  WeeklyReportResponse,
  WeeklyReportStatusValue,
} from "./types";
import type { ScorecardSubmissionPayload, ScorecardUpdatePayload } from "../scorecards/draft";
import type {
  WalkArtifactUploadUrlRequest,
  WalkArtifactUploadUrlResponse,
  WalkCompletionRequest,
  WalkCompletionResponse,
} from "../walkthrough/upload";

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
export const searchCaptureTargets = (
  f: Fetcher,
  search: string,
  limit = 20,
  dealsOnly = false,
  includeTerminalDeals = false,
) =>
  f<CaptureTargetsResponse>("/field/photo-targets/search", {
    // dealsOnly filters to deals server-side (before the result cap) for the scorecard picker.
    // includeTerminalDeals keeps that narrowing but drops the browsing stage rule dealsOnly also
    // carries — every ACTIVE deal, Lost included, which is what the walkthrough upload routes accept
    // and what the recovery picker has to be able to name. Narrowing server-side is the whole point:
    // the answer is capped before it is sent (per type in one office, then ONCE globally across
    // offices, ordered lead → opportunity → deal), so filtering on the phone filters a list the deals
    // may already have been cut from.
    query: {
      search,
      limit,
      ...(dealsOnly ? { dealsOnly: "true" } : {}),
      ...(dealsOnly && includeTerminalDeals ? { includeTerminalDeals: "true" } : {}),
    },
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

// The AI report is async — this returns as soon as the job is queued (202), then the caller polls
// getAiReportStatus. Nothing here waits on the 30-90s Claude pass, so the client's default request timeout
// is never in play.
export const startAiReport = (
  f: Fetcher,
  body: { projectId: string; photoIds: string[]; reportTitle?: string; focusPrompt?: string },
) => f<AiReportStartResponse>("/field/reports/ai-generate", { method: "POST", body });

export const getAiReportStatus = (f: Fetcher, runId: string) =>
  f<AiReportStatusResponse>(`/field/reports/ai-status/${runId}`);

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

// ── Weekly reports ────────────────────────────────────────────────────────────
// `/field/weekly-reports/...`, NOT `/weekly-reports`. This app signs in through `/auth/field-login`, which
// mints a `surface: "field"` token the server rejects on every CRM route by design (#722) — and the CRM
// weekly-report router is additionally gated to admin/director/rep, so a superintendent could never reach
// it even with a CRM session. Addressed at the CRM mount these would 401 on every call, which this app
// reads as a dead session and signs the user out.

// Everything the Reports hub renders, in one round trip: the projects this user owes reports on, plus
// anything sitting in their PM queue. One call because a jobsite LTE connection makes every extra request
// another chance to paint half a screen.
export const getWeeklyReportAssignments = (f: Fetcher) =>
  f<WeeklyReportAssignmentsResponse>("/field/weekly-reports/assignments");

// Start (or recover) the week's report. Idempotent on clientSubmissionId — stamped ONCE when the local
// draft is created and reused on every retry — so a request that times out on the way back never produces
// a second report for the week. 200 on a retry, 201 on a genuine create.
export const createWeeklyReport = (
  f: Fetcher,
  body: { clientSubmissionId: string; weeklyReportProjectId: string; weekOf: string },
) => f<WeeklyReportResponse>("/field/weekly-reports/reports", { method: "POST", body });

// `timeoutMs` is worth overriding on the hub's "Resume": that read sits between the user's tap and
// anything happening on screen, and the 30s default is half a minute of a stationary button on exactly the
// one-bar connection this feature is written for. Failing sooner is not a loss — the caller falls back to
// the local draft.
export const getWeeklyReport = (f: Fetcher, id: string, timeoutMs?: number) =>
  f<WeeklyReportDetailResponse>(`/field/weekly-reports/reports/${id}`, timeoutMs ? { timeoutMs } : {});

// PATCH semantics: an omitted key is left alone, an explicit null clears the column. The wizard always
// sends all five, because the local draft is the authoritative copy of what the user typed.
export const updateWeeklyReport = (
  f: Fetcher,
  id: string,
  body: {
    workCompleted?: string | null;
    nextWeekLookAhead?: string | null;
    issuesConcerns?: string | null;
    completionPercent?: number | null;
    weatherDelayDays?: number | null;
  },
) => f<WeeklyReportResponse>(`/field/weekly-reports/reports/${id}`, { method: "PATCH", body });

// The picker's candidate set: this deal's photos from the 14 days ENDING ON week_of. Anchored on the week
// the report covers rather than on today, so a report filed four days late still offers the right photos.
export const getWeeklyReportPhotoCandidates = (f: Fetcher, id: string) =>
  f<WeeklyReportPhotoCandidatesResponse>(`/field/weekly-reports/reports/${id}/photo-candidates`);

// Whole-set replacement: the array IS the selection and its ORDER is the print order (the server ignores
// any client-supplied sortOrder in favour of array position).
export const replaceWeeklyReportPhotos = (
  f: Fetcher,
  id: string,
  photos: Array<{ fileId: string; caption?: string | null }>,
) => f<WeeklyReportResponse>(`/field/weekly-reports/reports/${id}/photos`, { method: "PUT", body: { photos } });

// Submit for review / approve / bounce back. The PM gate is server-side: a superintendent posting
// `{"to":"approved"}` is refused regardless of what this app's buttons allow.
export const transitionWeeklyReport = (f: Fetcher, id: string, to: WeeklyReportStatusValue) =>
  f<WeeklyReportResponse>(`/field/weekly-reports/reports/${id}/transition`, { method: "POST", body: { to } });

/**
 * Clean a dictated transcript into report bullets, server-side.
 *
 * Sends the TRANSCRIPT and a CHARACTER COUNT — never the section the superintendent has already written.
 * The server therefore cannot return a rewritten section, and what comes back is only ever appended.
 * `existingChars` is what lets the server cap the addition so the two together stay inside the section
 * limit, which matters because dictation appends programmatically and no TextInput `maxLength` applies.
 *
 * `timeoutMs` is deliberately shorter than the 30s default. Somebody is standing on a jobsite holding the
 * phone while this runs, and there is a perfectly good answer waiting locally — waiting half a minute for
 * a nicer version of text we can already produce is the wrong trade. The caller
 * (weekly-reports/dictation.ts) falls back to the on-device split on any failure, including this timeout.
 */
export const formatWeeklyReportDictation = (
  f: Fetcher,
  body: { transcript: string; existingChars: number },
) =>
  f<WeeklyReportDictationResponse>("/field/weekly-reports/dictation", {
    method: "POST",
    body,
    timeoutMs: 20_000,
  });

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

// Active field-responder roster (supers + PMs) for the deal's office — powers the scorecard super/PM picker so
// the app selects from the same roster the CRM shows. Any failure degrades to free-text entry in the picker.
export const getFieldResponders = (f: Fetcher, dealId: string) =>
  f<FieldRespondersResponse>(`/field/projects/${dealId}/responders`);

// ── Glasses walkthroughs (AI walk) ──────────────────────────────────────────────
// The real server contract as of commit e901547bc — see ../walkthrough/upload.ts's "SERVER CONTRACT
// SEAM" comment and ../walkthrough/upload-client.ts, which binds these two calls into the
// WalkthroughUploadClient the upload queue is written against. `/deals/...` (not `/field/...`): these
// routes live on the deal itself (server/src/modules/deals/routes.ts), not the field surface.
//
// Both calls are under /field, NOT /deals. This app signs in through `/auth/field-login`, which mints a
// `surface: "field"` token, and the server rejects those on every CRM route by design (#722) — a field
// token must never be replayable against CRM/admin. Addressed at /deals these returned 401 "This session
// is not valid for CRM access" on every walk, and the app read that as a dead session and signed the user
// out, so one undeliverable walk locked the crew out of the app. Caught on a device, not in review.
//
// Step 1 (per artifact): presign an R2 PUT. dealId is a URL path segment on both calls, never a body
// field — the server derives it from the URL so a caller can never presign/file a walk under a project it
// cannot reach (see the field routes' comments on both handlers).
export const requestGlassesWalkthroughArtifactUploadUrl = (
  f: Fetcher,
  dealId: string,
  body: WalkArtifactUploadUrlRequest,
) =>
  f<WalkArtifactUploadUrlResponse>(`/field/projects/${dealId}/glasses-walkthroughs/artifacts/upload-url`, {
    method: "POST",
    body,
  });

// Step 2 (once per walk, after every artifact from step 1 is PUT): files the walk into the deal's
// project folder and hands forwarding to TROCK Scope off to the job queue.
export const submitGlassesWalkthrough = (f: Fetcher, dealId: string, body: WalkCompletionRequest) =>
  f<WalkCompletionResponse>(`/field/projects/${dealId}/glasses-walkthroughs`, { method: "POST", body });
