import type { ApiFetchOptions } from "./client";
import type {
  AuthResponse,
  InvitePreview,
  ProjectsResponse,
  StarredProjectsResponse,
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
} from "./types";

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
// When lat/lng are passed the server orders the list by proximity (closest first) and stamps each row's
// distanceMiles; otherwise the list is recency-ordered.
export const getProjects = (
  f: Fetcher,
  params: { search?: string; status?: string; page?: number; perPage?: number; lat?: number; lng?: number },
) => f<ProjectsResponse>("/field/projects", { query: { status: "active", ...params } });

// Accepts the same optional GPS fix as getProjects so starred rows carry matching distanceMiles.
export const getStarredProjects = (f: Fetcher, coords?: { lat: number; lng: number } | null) =>
  f<StarredProjectsResponse>("/field/projects/starred", {
    query: coords ? { lat: coords.lat, lng: coords.lng } : undefined,
  });

export const starProject = (f: Fetcher, dealId: string) =>
  f<StarResponse>(`/field/projects/${dealId}/star`, { method: "POST" });

export const unstarProject = (f: Fetcher, dealId: string) =>
  f<StarResponse>(`/field/projects/${dealId}/star`, { method: "DELETE" });

// ── Photos / gallery ──────────────────────────────────────────────────────────
export const getProjectPhotos = (
  f: Fetcher,
  dealId: string,
  params?: { category?: string; uploader?: string; from?: string; to?: string },
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

export const getProjectTags = (f: Fetcher, dealId: string, q: string, limit = 8) =>
  f<ProjectTagsResponse>(`/field/projects/${dealId}/tags`, { query: { q, limit } });

// ── Capture targets ───────────────────────────────────────────────────────────
export const searchCaptureTargets = (f: Fetcher, search: string, limit = 20) =>
  f<CaptureTargetsResponse>("/field/photo-targets/search", { query: { search, limit } });

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
