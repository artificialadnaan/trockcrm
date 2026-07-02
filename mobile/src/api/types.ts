import type { FieldProject, FieldPhoto, FieldCaptureTarget } from "../projects/field-projects";

export type { FieldProject, FieldPhoto, FieldCaptureTarget };

export type UserRole = string;

export type FieldUser = {
  id: string;
  email: string;
  firstName: string | null;
  lastName: string | null;
  role: UserRole;
  tenantId: string;
  active: boolean;
};

// ── Auth ────────────────────────────────────────────────────────────────────
export type AuthResponse = { user: FieldUser; token: string; csrfToken?: string };
export type InvitePreview = { firstName: string; lastName: string; email: string };

// ── Projects ──────────────────────────────────────────────────────────────────
export type ProjectsResponse = { projects: FieldProject[]; total: number; page: number; perPage: number };
export type StarredProjectsResponse = { projects: FieldProject[] };
export type NearbyProjectsResponse = { projects: FieldProject[]; degradedOffices?: string[] };
export type StarResponse = { starred: boolean };

// ── Photos ────────────────────────────────────────────────────────────────────
export type PhotosResponse = {
  photos: FieldPhoto[];
  pagination?: { page: number; limit: number; total: number; totalPages: number };
};
// Public photo-share link (POST /field/projects/:dealId/share). url = the unauthenticated viewer link.
export type ShareLinkResponse = {
  url: string;
  token: { id: string; expiresAt: string | null };
  photoCount: number;
};
export type PendingPhotosResponse = { photos: FieldPhoto[] };
export type ConfirmUploadResponse = { photo: FieldPhoto };
export type AssignTargetResponse = { photo: FieldPhoto };
export type TagsResponse = { tags: string[] };
export type ProjectTagsResponse = { tags: string[] };

export type UploadUrlRequest = {
  dealId?: string;
  leadId?: string;
  opportunityId?: string;
  contentType: string;
  sizeBytes: number;
  category?: string | null;
  caption?: string | null;
  tags?: string[];
};
export type UploadUrlResponse = {
  uploadUrl: string;
  objectKey: string;
  r2Key?: string;
  expiresIn?: number;
  uploadToken: string;
  systemFilename?: string;
  displayName?: string;
  folderPath?: string;
};
export type ConfirmUploadRequest = {
  dealId?: string;
  leadId?: string;
  opportunityId?: string;
  uploadToken: string;
  objectKey: string;
  /** Stable idempotency key so a resumed/background re-upload returns the existing photo, never a dup. */
  clientUploadId?: string;
  latitude?: number;
  longitude?: number;
  addressSource?: "exif" | "live_gps";
  takenAt?: string;
};

// ── Capture targets ───────────────────────────────────────────────────────────
export type CaptureTargetsResponse = { targets: FieldCaptureTarget[] };
export type ValidateTargetResponse = {
  target: { id: string; type: "deal" | "lead" | "opportunity" } & Partial<FieldCaptureTarget>;
};

// ── Voice transcription ───────────────────────────────────────────────────────
export type TranscribeConfig = { configured: boolean };
export type TranscribeResult = { transcript: string; language?: string; duration?: number };

// ── Reports ───────────────────────────────────────────────────────────────────
export type ReportGroupBy = "tag" | "date" | "none";

export type FieldReportPhoto = {
  id: string;
  displayName: string;
  description: string | null;
  takenAt: string | null;
  createdAt: string;
  uploaderName: string;
  imageUrl: string | null;
  tags: string[];
  projectName: string;
};
export type FieldReportSection = { id: string; title: string; photos: FieldReportPhoto[] };
export type ReportCover = {
  reportTitle: string;
  creatorName: string;
  companyName: string;
  reportDateLabel: string;
  projectName: string;
  photoCount: number;
};
export type ReportPreviewResponse = { cover: ReportCover; sections: FieldReportSection[] };

export type GenerateReportSection = {
  title: string;
  photoIds: string[];
  photoOverrides?: Array<{ id: string; description?: string | null }>;
};
export type GenerateReportRequest = {
  projectId: string;
  reportTitle: string;
  coverData: {
    creatorName: string;
    companyName?: string | null;
    reportDateLabel?: string | null;
    projectName?: string | null;
  };
  sections: GenerateReportSection[];
};
export type GeneratedReport = {
  id: string;
  title: string;
  pdfUrl: string;
  expiresAt: string;
  createdAt: string;
};
export type GenerateReportResponse = { report: GeneratedReport };

export type FieldProjectReportSummary = {
  id: string;
  title: string;
  description: string | null;
  createdAt: string;
  expiresAt: string | null;
};
export type ReportsResponse = { reports: FieldProjectReportSummary[] };
export type ReportDownloadResponse = { url: string; filename: string };

// ── Field Scorecards ────────────────────────────────────────────────────────
export type ScorecardRatingValue = "elite" | "on_standard" | "needs_improvement" | "corrective_action";
export type FieldScorecardSummary = {
  id: string;
  dealId: string;
  weekOf: string;
  totalScore: number;
  rating: ScorecardRatingValue;
  ratingLabel: string;
  superintendentName: string | null;
  pmName: string | null;
  projectNumber: string | null;
  criticalDeficiencyCount: number;
  submittedByName: string | null;
  submittedAt: string;
  officeSlug?: string;
  officeId?: string;
};
export type FieldScorecardItemView = { sectionKey: string; points: number; note: string | null };
export type FieldScorecardPhotoView = {
  id: string;
  sectionKey: string;
  fileId: string;
  url: string | null;
  caption: string | null;
};
export type FieldScorecardDetail = FieldScorecardSummary & {
  items: FieldScorecardItemView[];
  criticalDeficiencies: string[];
  actionItems: string[];
  photos: FieldScorecardPhotoView[];
};
export type RecentScorecardsResponse = { scorecards: FieldScorecardSummary[]; degradedOffices?: string[] };
export type ProjectScorecardsResponse = {
  scorecards: FieldScorecardSummary[];
  officeSlug?: string;
  officeId?: string;
};
export type ScorecardDetailResponse = { scorecard: FieldScorecardDetail };
export type CreateScorecardResponse = { scorecard: FieldScorecardSummary };
