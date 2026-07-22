import type { FieldProject, FieldPhoto, FieldCaptureTarget } from "../projects/field-projects";
import type { ScorecardSectionKey, ScorecardLeadershipSectionKey, ScorecardKind } from "../scorecards/scoring";

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

type UploadUrlRequestBase = {
  dealId?: string;
  leadId?: string;
  opportunityId?: string;
  contentType: string;
  sizeBytes: number;
  category?: string | null;
  caption?: string | null;
  tags?: string[];
};

/** A submitted-card edit upload must carry the queue id used to persist its exact authorization scope. */
type UploadUrlScorecardScope =
  | { scorecardId: string; clientUploadId: string }
  | { scorecardId?: never; clientUploadId?: string };

export type UploadUrlRequest = UploadUrlRequestBase & UploadUrlScorecardScope;
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
  /** Must match the submitted-card edit scope used to mint the upload URL. */
  scorecardId?: string;
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
  /** Optional free-form executive summary; rendered on its own page(s) right after the cover. */
  executiveSummary?: string | null;
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
  /** Current canonical deal/job name. Optional while older API deployments roll out. */
  projectName?: string | null;
  projectNumber: string | null;
  criticalDeficiencyCount: number;
  submittedByName: string | null;
  submittedAt: string;
  /** PDF-availability signal from the server: the artifact renders async, so it may be false right after submit. */
  hasPdf?: boolean;
  officeSlug?: string;
  officeId?: string;
  /**
   * Submitted-card lifecycle status: `submitted` | `corrective_action_open` | `corrective_action_closed`.
   * Drives the project Scorecards list affordance (open → "Corrective action required", closed → "Resolved").
   * Optional so older API deployments that don't emit it still parse (a missing value reads as `submitted`).
   */
  status?: string;
  /**
   * True iff the CURRENT viewer may respond to this card's corrective action (assigned super/PM on the deal,
   * or an admin/director) — the same predicate the responder endpoint enforces. A DEAL-level fact the server
   * resolves once for every card in listFieldScorecardsForProject. Gates the project-list "Document the
   * corrective action" CTA so a browse-only field user isn't routed into a 403. Optional so older API
   * deployments that don't emit it still parse (treat a missing value as "cannot respond").
   */
  canRespondToCorrectiveAction?: boolean;
  formVersion?: 1 | 2;
  /** Discriminates project (default) vs leadership cards — the submitted list scores leadership out of 10. */
  kind?: ScorecardKind;
  averageScore?: number | null;
};
export type FieldScorecardItemView = {
  // Leadership cards key items by the 4 leadership sections; project cards by the V2 section keys.
  sectionKey: ScorecardSectionKey | ScorecardLeadershipSectionKey;
  points: number;
  note: string | null;
};
export type FieldScorecardPhotoView = {
  id: string;
  // Leadership evidence attaches to one of its four categories or the Project Summary (`project_summary`).
  sectionKey: ScorecardSectionKey | ScorecardLeadershipSectionKey | "critical_deficiency" | "project_summary";
  deficiencyKey?: string | null;
  fileId: string;
  /** Durable upload identity used to reconcile a PUT that committed after its response was lost. */
  clientUploadId?: string | null;
  url: string | null;
  caption: string | null;
};
export type FieldScorecardDetail = FieldScorecardSummary & {
  /** Server-authoritative owner check: true only for the user who originally submitted this scorecard. */
  canEdit: boolean;
  /** Optimistic-concurrency token used when replacing an editable scorecard. */
  updatedAt: string;
  criticalDeficiencyNotes?: Record<string, string>;
  superintendentSignature?: string | null;
  pmSignature?: string | null;
  items: FieldScorecardItemView[];
  criticalDeficiencies: string[];
  actionItems: string[];
  photos: FieldScorecardPhotoView[];
  /** Leadership Project Summary free text. */
  summary?: string | null;
};
export type RecentScorecardsResponse = { scorecards: FieldScorecardSummary[]; degradedOffices?: string[] };
export type ProjectScorecardsResponse = {
  scorecards: FieldScorecardSummary[];
  officeSlug?: string;
  officeId?: string;
};
export type ScorecardDetailResponse = { scorecard: FieldScorecardDetail };
// Presigned scorecard-PDF download (GET /field/scorecards/:id/download).
// Matches server getFieldScorecardPdfDownload: { url, expiresAt } — NOT the report { url, filename } shape.
export type ScorecardDownloadResponse = { url: string; expiresAt: string };
export type CreateScorecardResponse = { scorecard: FieldScorecardSummary };
export type UpdateScorecardResponse = { scorecard: FieldScorecardSummary };

// The deal's assigned Superintendent + PM names, as returned by the FIELD route
// GET /field/projects/:dealId/team. The server already resolves the two roles from the ACTIVE team rows
// (with active user/contact identities), so the app just seeds these directly — no client-side role match.
export type DealTeamResponse = { superintendentName: string | null; pmName: string | null };

// ── Corrective actions ────────────────────────────────────────────────────────
// A response-evidence photo linked to a corrective-action item. Mirrors the server's
// CorrectiveActionResponsePhoto (corrective-action-api.ts). The read endpoint now resolves a presigned `url`
// (same presigner as scorecard evidence); it is optional so an older API deployment (or a failed resolution)
// degrades to a fileId chip instead of an <Image>. `clientUploadId` is the durable mobile upload identity
// when the photo came from this app.
export type CorrectiveActionResponsePhoto = {
  id: string;
  fileId: string;
  clientUploadId: string | null;
  url?: string | null;
  caption: string | null;
};
// One flagged corrective-action item (an action item or critical deficiency) with its inline response.
// Matches the server's CorrectiveActionItemView field-for-field. `itemType`/`status` are kept as broad
// strings (the server column is a varchar) so an unknown future value never breaks the parse.
export type CorrectiveActionItem = {
  id: string;
  itemType: string;
  itemRef: string;
  itemLabel: string;
  status: string;
  responseComment: string | null;
  respondedByUserId: string | null;
  responderName: string | null;
  responderEmail: string | null;
  respondedAt: string | null;
  photos: CorrectiveActionResponsePhoto[];
};
// GET /field/scorecards/:id/corrective-actions and the POST response both wrap the items in `{ items }`
// (corrective-action-routes.ts) — there is no top-level scorecardId/status on the wire.
export type CorrectiveActionsResponse = { items: CorrectiveActionItem[] };
