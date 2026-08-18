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

// ── AI report (async: enqueue → poll) ────────────────────────────────────────
export type AiReportRunStatus = "queued" | "running" | "succeeded" | "failed";
export type AiReportStartResponse = { runId: string; status: AiReportRunStatus };
/** `report` is present only once status === "succeeded"; `error` only once status === "failed". */
export type AiReportStatusResponse = {
  runId: string;
  status: AiReportRunStatus;
  report?: GeneratedReport;
  error?: string;
};

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
  /**
   * `deals.is_change_order` for `projectName` — the AUTHORITY for the change-order display relabel.
   * Optional and possibly ABSENT: an older API deployment omits it, and absent must stay absent (the
   * display helper then reads the name). Never default this to false — false is an assertion.
   */
  isChangeOrder?: boolean | null;
  projectNumber: string | null;
  criticalDeficiencyCount: number;
  submittedByName: string | null;
  submittedAt: string;
  /** PDF-availability signal from the server: the artifact renders async, so it may be false right after submit. */
  hasPdf?: boolean;
  officeSlug?: string;
  officeId?: string;
  /**
   * Submitted-card lifecycle status: `submitted` | `corrective_action_open` | `corrective_action_submitted`
   * | `corrective_action_closed`. Note `corrective_action_submitted` is the APPROVER'S queue — the responder
   * has answered and is waiting on a verdict — and `corrective_action_closed` now means APPROVED.
   * Drives the project Scorecards list affordance (open → "Corrective action required", submitted →
   * "Awaiting approval", closed → "Approved").
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
  /**
   * The field-responder roster person currently linked to each role on this card (null when the name was
   * typed). The edit form rehydrates these so a full-replacement PUT round-trips the pick instead of
   * clearing it. Optional so an older API deployment that doesn't emit them still parses.
   */
  superintendentResponderId?: string | null;
  pmResponderId?: string | null;
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

// ── Field responders (scorecard super/PM picker) ──────────────────────────────
// The active field-responder roster (superintendents + project managers) for a deal's office, from
// GET /field/projects/:dealId/responders → { responders: [{ id, name, email, role }] }. Powers the
// scorecard Super/PM dropdown so the app selects from the same roster the CRM shows. Picking a row stores the
// roster `id` alongside the name on the draft (typing stores the name only), and that id travels with the
// submission: the server then routes this card's corrective-action + completed-scorecard email to the picked
// person instead of the deal's Team-tab super/PM.
export type FieldResponderRole = "superintendent" | "project_manager";
export type FieldResponderOption = { id: string; name: string; email: string; role: FieldResponderRole };
export type FieldRespondersResponse = { responders: FieldResponderOption[] };

// ── Weekly reports ────────────────────────────────────────────────────────────
// The client-facing weekly progress report, authored on the phone and reviewed by the PM. Served from
// /field/weekly-reports — a FIELD mount, because this app's `surface: "field"` token is rejected on every
// CRM route (#722) and the CRM's own /weekly-reports router is additionally gated to admin/director/rep.
//
// `status` and `weekState` are kept as broad unions rather than plain strings because the app switches on
// them to choose a label and an action; an unknown value falls through to a neutral chip.
export type WeeklyReportStatusValue = "draft" | "pending_review" | "approved" | "sent";
export type WeeklyReportWeekStateValue = WeeklyReportStatusValue | "not_started" | "dismissed";

/** One project the signed-in user owes reports on. */
export type WeeklyReportAssignment = {
  weeklyReportProjectId: string;
  dealId: string;
  projectName: string;
  projectNumber: string | null;
  clientName: string | null;
  /** The viewer's relationship to this project. Both are true on a one-person job. */
  isSuper: boolean;
  isPm: boolean;
  cadenceWeekday: number;
  /** What `week_of` auto-fills to — the cadence due date, NOT today. */
  currentWeekOf: string;
  currentState: WeeklyReportWeekStateValue;
  currentReportId: string | null;
  currentReportStatus: WeeklyReportStatusValue | null;
  /**
   * False once reporting has ENDED but missed weeks remain: `currentWeekOf` is then past the cadence end
   * date and the server refuses it, so the card must not offer to start it.
   */
  currentWeekFilable: boolean;
  /**
   * How late the OLDEST week still owed is — over the whole backlog, not just the weeks this payload
   * carries. 0 when only the current, not-yet-due week is outstanding.
   */
  daysLate: number;
  /**
   * Earlier weeks still owed, oldest first. Offered, never auto-selected. A week whose only report is a
   * DRAFT is still owed and still listed: the wizard creates the row on the photos step, so dropping it
   * once a row existed put the week beyond reach of the phone entirely.
   */
  outstandingWeeks: string[];
  /**
   * weekOf → the report id an outstanding week already has, so the wizard resumes that row instead of
   * posting a second create. Only weeks that were started appear. Optional: an older API build does not
   * send it, and absent simply means every outstanding week starts fresh, as it did before.
   */
  outstandingWeekReportIds?: Record<string, string>;
  hasMoreOutstandingWeeks: boolean;
  previousWeekOf: string | null;
  previousCompletionPercent: number | null;
  previousWeatherDelayDays: number | null;
  /** Predecessor figures keyed by the week being filled — cumulative values must not cross weeks. */
  previousByWeekOf?: Record<
    string,
    { weekOf: string; completionPercent: number | null; weatherDelayDays: number | null }
  >;
};

/** One row of the PM's review queue. */
export type WeeklyReportReviewItem = {
  reportId: string;
  weeklyReportProjectId: string;
  dealId: string;
  projectName: string;
  weekOf: string;
  status: WeeklyReportStatusValue;
  authoredByName: string | null;
  submittedAt: string | null;
};

export type WeeklyReportAssignmentsResponse = {
  asOf: string;
  projects: WeeklyReportAssignment[];
  /** Newest week first — the queue only empties when a report is SENT, so the tail is the stale end. */
  pendingReview: WeeklyReportReviewItem[];
  /**
   * The true depth of the queue, which the payload caps. Greater than `pendingReview.length` ⇒ rows were
   * left out and the hub must say so. Optional because an older API build does not send it; absent is
   * read as "not truncated", which is what the app assumed before the field existed.
   */
  pendingReviewTotal?: number;
};

/**
 * A photo on a report. `caption` is REPORT-SPECIFIC: the server seeds it from `originalDescription` and
 * never writes an edit back to the file, so retitling a photo for a client cannot rewrite what the crew
 * typed on site.
 */
export type WeeklyReportPhotoView = {
  fileId: string;
  caption: string | null;
  originalDescription: string | null;
  sortOrder: number;
  takenAt: string | null;
  mimeType: string | null;
  /** Presigned by the field route; the services deal in file ids. Null when unresolvable. */
  thumbnailUrl: string | null;
  fullUrl: string | null;
};

export type WeeklyReportPhotoCandidate = WeeklyReportPhotoView & {
  /** The `week_of` of an earlier report this photo already appeared on, so it isn't repeated by accident. */
  alreadyUsedOn: string | null;
  selected: boolean;
};

export type WeeklyReportDetailView = {
  id: string;
  weeklyReportProjectId: string;
  dealId: string;
  weekOf: string;
  version: number;
  status: WeeklyReportStatusValue;
  workCompleted: string | null;
  nextWeekLookAhead: string | null;
  issuesConcerns: string | null;
  completionPercent: number | null;
  weatherDelayDays: number | null;
  remainingWeeks: number | null;
  projectedDurationWeeks: number | null;
  authoredByName: string | null;
  submittedAt: string | null;
  reviewedAt: string | null;
  sentAt: string | null;
  photos: WeeklyReportPhotoView[];
};

/** The standing setup the report prints its header from. */
export type WeeklyReportProjectView = {
  id: string;
  dealId: string;
  dealName: string | null;
  propertyDisplayName: string | null;
  clientName: string | null;
  trockPmName: string | null;
  trockSuperName: string | null;
  projectStartDate: string | null;
  projectCompletionDate: string | null;
  projectedDurationWeeks: number | null;
  cadenceWeekday: number;
};

/**
 * Resolved SERVER-SIDE and shipped with the payload rather than re-derived here.
 *
 * The PM reviews on either surface, so two clients each deriving "can I approve this?" from a status and
 * a pair of user ids would eventually disagree with each other and with the service that enforces it —
 * and the visible failure is a button that 403s.
 */
export type WeeklyReportPermissions = {
  canEdit: boolean;
  canSubmit: boolean;
  canApprove: boolean;
  canReturnToDraft: boolean;
};

// ── The client send ───────────────────────────────────────────────────────────
// The email the client receives is COMPOSED SERVER-SIDE and shipped here as data. Nothing below is
// re-derived on the phone: the subject, the greeting, the default message and the body preview all arrive
// from GET /field/weekly-reports/reports/:id/send-draft, and the CRM's dialog renders the very same
// payload from the same service. A second implementation of any of it on either surface would mean the PM
// approves one wording and the client receives another.

/** A client-team address the modal offers. `role` is the label the report prints (DOC / PM / RM / CM). */
export type WeeklyReportRecipientOption = { role: string; name: string | null; email: string };

/** The T-Rock PM block that signs the email — what the client replies to. */
export type WeeklyReportSenderContact = {
  name: string | null;
  email: string | null;
  phone: string | null;
};

export type WeeklyReportSendDraftView = {
  reportId: string;
  weekOf: string;
  version: number;
  /**
   * True only when an EARLIER version of this week actually reached the client. Deliberately not
   * `version > 1`: a v2 whose v1 never got out is not a correction, it is a first copy, and telling a
   * client that this "replaces the copy they already have" sends them hunting for an email that does not
   * exist. The banner the app shows and the sentence the client reads come from this one flag.
   */
  isCorrection: boolean;
  propertyName: string | null;
  /** The pre-filled selection. */
  recipients: string[];
  /** Everything the client team offers, so a role with an address can be re-added without retyping it. */
  recipientOptions: WeeklyReportRecipientOption[];
  subject: string;
  greeting: string;
  /** The one part the PM edits. */
  contextParagraph: string;
  sender: WeeklyReportSenderContact;
  attachPdf: boolean;
  /** The exact plain-text body the client will receive, given the values above. Preview, not input. */
  bodyPreview: string;
};

export type WeeklyReportSendDraftResponse = { draft: WeeklyReportSendDraftView };

/**
 * The send's answer — and the ONE moment the raw client link exists.
 *
 * `public.weekly_report_tokens` stores a SHA-256 hash of the token, so this URL is unreproducible: no
 * later API call returns it, and the send draft above deliberately does not carry it. The screen shows it
 * once, for copying, and it MUST NOT be written to the draft store, a log line or crash telemetry.
 */
export type WeeklyReportSendResponse = { report: WeeklyReportDetailView; shareUrl: string };

export type WeeklyReportResponse = { report: WeeklyReportDetailView };
export type WeeklyReportDetailResponse = {
  report: WeeklyReportDetailView;
  project: WeeklyReportProjectView;
  permissions: WeeklyReportPermissions;
};
export type WeeklyReportPhotoCandidatesResponse = {
  photos: WeeklyReportPhotoCandidate[];
  /**
   * The true size of the window, which `photos` caps. Greater than `photos.length` ⇒ the oldest days of
   * the fortnight were left out and the picker must say so. Optional for an older API build.
   */
  total?: number;
};

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
// One entry in a corrective-action item's thread. Matches the server's CorrectiveActionEventView
// (corrective-action-api.ts:35). `eventType` stays a broad string for the same reason `status` does.
export type CorrectiveActionEvent = {
  id: string;
  eventType: string;
  actorName: string | null;
  actorEmail: string | null;
  comment: string | null;
  createdAt: string | null;
  /** Photos filed with THIS attempt. Empty for approvals and rejections. */
  photos: CorrectiveActionResponsePhoto[];
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
  /**
   * The full thread, oldest first. The columns above hold only the LATEST attempt — a resubmission
   * overwrites them — so this is the only place a rejection and what it asked for survives.
   *
   * The server has emitted this since the thread shipped (corrective-action-api.ts:64, populated at
   * :162 with `?? []`, so it is always an array). It was missing here, and because `mobile/` is not in
   * the root `workspaces` array nothing in CI compiles this file — the corrective-action detail screen
   * has been reading `item.events` against a type that never declared it.
   */
  events: CorrectiveActionEvent[];
};
// GET /field/scorecards/:id/corrective-actions and the POST response both wrap the items in `{ items }`
// (corrective-action-routes.ts) — there is no top-level scorecardId/status on the wire.
export type CorrectiveActionsResponse = { items: CorrectiveActionItem[] };

// The scorecard-SCOPED corrective-action response-photo upload (server resolves the SCORECARD's owning
// office, NOT the uploader's active office). Distinct from the generic /field/photos upload contract: no
// capture target / clientUploadId / tags, and confirm returns a bare { fileId } for the response POST.
export type CorrectiveActionUploadUrlResponse = {
  uploadUrl: string;
  objectKey: string;
  uploadToken: string;
  expiresIn: number;
};
export type CorrectiveActionConfirmUploadResponse = { fileId: string };
