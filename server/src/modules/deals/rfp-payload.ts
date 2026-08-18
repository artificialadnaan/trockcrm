import { resolveDealDisplayNumber } from "@trock-crm/shared/types";
import { resolveProjectTypeCode } from "../../services/projectNumber.js";

type WorkflowRoute = "normal" | "service";

export interface RfpPayloadSourceDeal {
  id: string;
  name: string;
  dealNumber: string;
  /** Canonical formatted number (`deals.project_number`). Preferred over `dealNumber`
   *  so the payload never ships the raw HubSpot id. See resolveDealDisplayNumber. */
  projectNumber?: string | null;
  projectType?: string | null;
  /** The CONFIGURED project-type digit (project_type_config.code via project_type_id). See isServiceRfp. */
  projectTypeCode?: string | null;
  workflowRoute?: WorkflowRoute | null;
  awardedAmount?: string | number | null;
  bidEstimate?: string | number | null;
  ddEstimate?: string | number | null;
  forecastRevenue?: string | number | null;
  estimator?: string | null;
  bidBoardEstimator?: string | null;
  /** Deal owner / rep — the "Requested by" person. Resolved at enqueue time from
   *  assigned_rep → user, with fallbacks (see rfp-enqueue resolveDealOwner). */
  ownerName?: string | null;
  ownerEmail?: string | null;
  companyName?: string | null;
  contactName?: string | null;
  clientEmail?: string | null;
  clientPhone?: string | null;
  propertyAddress?: string | null;
  propertyCity?: string | null;
  propertyState?: string | null;
  propertyZip?: string | null;
  propertyCountry?: string | null;
  description?: string | null;
  /**
   * Pre-rendered CRM activity history (see bid-board-activity-note.ts). SyncHub posts it as a NOTE on
   * the Bid Board project's Overview tab — never into Project Description, which stays the deal
   * description only. Null when the deal has no activity.
   */
  crmActivityLog?: string | null;
  bidDueDate?: Date | string | null;
  bidBoardDueDate?: Date | string | null;
  createdAt?: Date | string | null;
}

export interface NormalizedRfpRequestBody {
  sourceSystem: "trock_crm";
  sourceDealId: string;
  sourceEventId: string;
  deal: {
    name: string;
    projectNumber: string;
    projectType: string;
    amount: number | null;
    estimator: string | null;
    ownerName: string | null;
    ownerEmail: string | null;
    companyName: string | null;
    contactName: string | null;
    clientEmail: string | null;
    clientPhone: string | null;
    address: {
      street: string | null;
      city: string | null;
      state: string | null;
      zip: string | null;
      country: string | null;
    } | null;
    description: string | null;
    /**
     * The deal's CRM activity history as plain text, for the Note SyncHub posts on the Bid Board
     * project. `.nullable().optional()` in SyncHub's contract, so it is safe to drop entirely — which
     * fitWithinBudget does first, ahead of everything else.
     */
    crmActivityLog: string | null;
    dueDate: string | null;
    workflowRoute: string | null;
  };
  attachments: RfpAttachment[];
  /** How many attachments were dropped to keep the body parseable by SyncHub (0 when none). */
  attachmentsOmitted: number;
}

export interface RfpAttachment {
  name: string;
  url: string;
  contentType: string;
}

/**
 * A CRM `files` row reduced to the fields needed to build an RFP attachment.
 * The download URL is resolved by an injected resolver so this stays pure and
 * testable without R2 or a database.
 */
export interface RfpAttachmentSourceFile {
  /** `files.id` — needed to scope the photo share token to exactly the photos the link will show. */
  id?: string;
  displayName: string;
  fileExtension: string | null;
  mimeType: string;
  /** `files.file_size_bytes` — the public viewer refuses to transcode oversized non-JPEG rasters. */
  fileSizeBytes?: number | null;
  r2Key: string;
  /** `files.category`. "photo" rows collapse into a single share link — see buildRfpAttachments. */
  category?: string | null;
}

/**
 * Marks the one attachment that is a viewer link rather than a file. It is placed first and is the
 * ONLY route to a collapsed deal's photos, so the size cap protects it (see fitWithinBudget).
 */
export const RFP_PHOTO_SHARE_CONTENT_TYPE = "text/html";

/** How many leading attachments the size cap must preserve: the photo share link, when present. */
export function protectedAttachmentCount(attachments: RfpAttachment[]): number {
  return attachments[0]?.contentType === RFP_PHOTO_SHARE_CONTENT_TYPE ? 1 : 0;
}

/**
 * Maps active deal files to the SyncHub attachment contract. `resolveUrl`
 * produces the (presigned) download URL — generation is async and injected so
 * callers control TTL and so this is unit-testable with a stub resolver.
 */
export async function buildRfpAttachmentsFromFiles(
  files: RfpAttachmentSourceFile[],
  resolveUrl: (input: { r2Key: string; filename: string }) => Promise<string>
): Promise<RfpAttachment[]> {
  return Promise.all(
    files.map(async (file) => {
      const filename = file.displayName + (file.fileExtension ?? "");
      return {
        name: filename,
        url: await resolveUrl({ r2Key: file.r2Key, filename }),
        contentType: file.mimeType,
      };
    })
  );
}

/**
 * Builds the attachment list SyncHub receives, collapsing the deal's PHOTOS into one public
 * share link instead of one presigned R2 URL per photo.
 *
 * Photos are what make a deal file-heavy, and at ~800 bytes per presigned URL a few hundred of
 * them alone exceeded SyncHub's 100kb parser limit — the 413 on TRK-2607-H3X6. One `/p/<token>`
 * link is ~60 bytes and, because that viewer streams through our own server rather than handing
 * out presigned URLs, it also outlives the 7-day SigV4 maximum the per-file attachments are
 * capped at.
 *
 * The link is placed FIRST so the body-size cap — which drops from the tail — can never discard it.
 * If no link can be minted (the public viewer base URL is unconfigured), we fall back to the
 * per-photo attachments rather than silently shipping an RFP with no photos at all.
 */
export async function buildRfpAttachments(
  files: RfpAttachmentSourceFile[],
  deps: {
    resolveUrl: (input: { r2Key: string; filename: string }) => Promise<string>;
    /** Mints a `/p/<token>` link scoped to exactly these photo ids. Null when none can be minted. */
    mintPhotoShareUrl: (photoIds: string[]) => Promise<string | null>;
    /** True when the public viewer can actually serve this photo (JPEG always; other rasters only
     *  under the transcode size cap; HEIC/HEIF never). Defaults to "all", for callers that pass a
     *  pre-filtered list. */
    canViewerServe?: (file: RfpAttachmentSourceFile) => boolean;
    /** The viewer renders ONE page and exposes no pagination, so only this many photos are reachable
     *  through the link. */
    viewerPhotoLimit?: number;
  }
): Promise<RfpAttachment[]> {
  const canServe = deps.canViewerServe ?? (() => true);
  const limit = deps.viewerPhotoLimit ?? Number.POSITIVE_INFINITY;

  const photos = files.filter((file) => file.category === "photo");
  // Only photos the viewer will BOTH list (page-1 limit) and serve (format/size) may be collapsed.
  // Everything else keeps its own presigned attachment — otherwise the label promises the reviewer
  // photos the link cannot show, and for HEIC/HEIF they would get a placeholder and no file at all.
  const collapsible = photos.filter((file) => file.id && canServe(file)).slice(0, limit);
  const collapsedIds = new Set(collapsible.map((file) => file.id));

  const shareUrl = collapsible.length > 0 ? await deps.mintPhotoShareUrl(collapsible.map((f) => f.id!)) : null;

  const individually = shareUrl ? files.filter((file) => !file.id || !collapsedIds.has(file.id)) : files;
  const attachments = await buildRfpAttachmentsFromFiles(individually, deps.resolveUrl);

  if (!shareUrl) return attachments;
  return [
    {
      name: `Project Photos (${collapsible.length})`,
      url: shareUrl,
      contentType: RFP_PHOTO_SHARE_CONTENT_TYPE,
    },
    ...attachments,
  ];
}

export interface RfpRequestDeliveryPayload {
  dealId: string;
  syncHubUrl: string;
  body: NormalizedRfpRequestBody;
}

function cleanString(value: unknown): string | null {
  const text = String(value ?? "").trim();
  return text.length > 0 ? text : null;
}

function cleanNumber(value: unknown): number | null {
  if (value == null || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function cleanIso(value: Date | string | null | undefined): string | null {
  if (!value) return null;
  const parsed = value instanceof Date ? value : new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null;
}

/**
 * The ONE precedence that turns a deal's four value columns into the single `amount` SyncHub stores.
 *
 * `buildNormalizedRfpRequestBody` (the send-time snapshot) and the internal
 * `POST /api/internal/deals/current-values` batch lookup (the report's render-time resolution) BOTH
 * call this. Keep it that way: a second copy of the ordering would let the number a reviewer saw in
 * the RFP email and the number the RFP report shows for the same deal drift apart silently.
 */
export function resolveRfpDealAmount(deal: {
  awardedAmount?: string | number | null;
  bidEstimate?: string | number | null;
  ddEstimate?: string | number | null;
  forecastRevenue?: string | number | null;
}): number | null {
  return (
    cleanNumber(deal.awardedAmount) ??
    cleanNumber(deal.bidEstimate) ??
    cleanNumber(deal.ddEstimate) ??
    cleanNumber(deal.forecastRevenue)
  );
}

function buildAddress(deal: RfpPayloadSourceDeal): NormalizedRfpRequestBody["deal"]["address"] {
  const street = cleanString(deal.propertyAddress);
  const city = cleanString(deal.propertyCity);
  const state = cleanString(deal.propertyState);
  const zip = cleanString(deal.propertyZip);
  const country = cleanString(deal.propertyCountry);
  if (!street && !city && !state && !zip && !country) return null;

  return {
    street,
    city,
    state,
    zip,
    country: country ?? "US",
  };
}

export function resolveSyncHubBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  return (env.SYNCHUB_BASE_URL ?? env.SYNC_HUB_BASE_URL ?? env.SYNCHUB_URL ?? "http://localhost:5000").replace(
    /\/+$/,
    ""
  );
}

export function resolveSyncHubRfpRequestUrl(env: NodeJS.ProcessEnv = process.env): string {
  return `${resolveSyncHubBaseUrl(env)}/api/rfp-requests`;
}

export function resolveSyncHubCreateFromRfpUrl(env: NodeJS.ProcessEnv = process.env): string {
  return `${resolveSyncHubBaseUrl(env)}/api/bid-board/create-from-rfp`;
}

/**
 * SyncHub's authoritative override-approve endpoint for a previously-declined RFP request.
 * `requestId` is the SyncHub rfp_approval_requests.id (the integer the CRM stored as rfp_approval_request_id).
 */
export function resolveSyncHubOverrideApproveUrl(
  requestId: number,
  env: NodeJS.ProcessEnv = process.env
): string {
  return `${resolveSyncHubBaseUrl(env)}/api/rfp-requests/${encodeURIComponent(String(requestId))}/override-approve`;
}

/**
 * SyncHub parses BOTH RFP endpoints it exposes to us — POST /api/rfp-requests and
 * POST /api/bid-board/create-from-rfp — with `express.json()` and NO `limit` option, so they
 * cap at the body-parser default. Measured against production: a 102,395-byte body is accepted
 * and a 104,443-byte body is rejected, i.e. the wall is exactly 100kb.
 *
 * Over that, SyncHub rejects at the PARSER — before the signature check — and its production
 * error middleware masks the message, so the CRM surfaces the useless
 * "RFP delivery failed with 413: Internal server error" (TRK-2607-H3X6).
 */
export const SYNCHUB_JSON_BODY_LIMIT_BYTES = 100 * 1024;

/**
 * What we actually target. Kept below the hard limit so a body that fits here can't be pushed
 * over the wall by anything outside our measurement (proxy framing, a SyncHub-side re-encode).
 */
export const RFP_BODY_BYTE_BUDGET = 90 * 1024;

const DESCRIPTION_TRUNCATED_SUFFIX = " […] (truncated for delivery — open the deal in the CRM for the full description)";

/**
 * Optional display fields, in the order we are willing to lose them. Every one is `.nullable()` in
 * SyncHub's contract, so dropping one can never turn a 413 into a 422.
 */
const SACRIFICIAL_DEAL_FIELDS = [
  "estimator",
  "clientPhone",
  "clientEmail",
  "contactName",
  "companyName",
  "ownerEmail",
  "ownerName",
  "description",
] as const;

/**
 * Hard ceiling for the fields SyncHub requires to be non-empty (`.min(1)`). `deals.project_type`,
 * `deals.project_number`, `deals.estimator`, `deals.property_address` and `deals.property_country`
 * are all unbounded `text` columns, so a pathological value has to be clamped rather than dropped.
 */
const REQUIRED_FIELD_MAX_CHARS = 500;

function clampRequired<T>(value: T): T {
  // Only clamps strings; a stored payload of an older shape may carry something else here, and the
  // limiter must not throw on it.
  if (typeof value !== "string" || value.length <= REQUIRED_FIELD_MAX_CHARS) return value;
  return value.slice(0, REQUIRED_FIELD_MAX_CHARS) as unknown as T;
}

function serializedBytes(body: unknown): number {
  return Buffer.byteLength(JSON.stringify(body));
}

/**
 * Shrinks the body until SyncHub will parse it. The deal fields are a ~730-byte floor, so the
 * only unbounded inputs are the description and the attachment list — we give up the pathological
 * description first (it has a CRM fallback), then drop attachments from the TAIL, which callers
 * order newest-first so the most relevant documents survive.
 */
/**
 * Trims `body.attachments` to the longest leading run that fits, keeping at least `minKeep`.
 *
 * Serialized JSON is a flat concatenation, so an attachment's byte cost is INDEPENDENT of the
 * others: `total(k) = base + Σ len(item_i) + (k-1) commas`. That means one serialization per
 * attachment plus one for the rest of the body — linear. Popping one at a time and re-serializing
 * was quadratic: ~1,900 full serializations of a multi-megabyte payload for a 2,000-photo deal,
 * blocking the event loop while the tenant transaction is open.
 */
function trimAttachmentsToBudget(body: NormalizedRfpRequestBody, budget: number, minKeep: number): void {
  const attachments = body.attachments;
  if (attachments.length === 0) return;

  const withoutAttachments = { ...body, attachments: [] as RfpAttachment[] };
  const baseBytes = serializedBytes(withoutAttachments);

  let keep = 0;
  let running = baseBytes;
  for (let i = 0; i < attachments.length; i += 1) {
    // +1 for the comma separating this item from the previous one.
    running += Buffer.byteLength(JSON.stringify(attachments[i])) + (i > 0 ? 1 : 0);
    if (running > budget) break;
    keep = i + 1;
  }

  const target = Math.max(minKeep, keep);
  if (target >= attachments.length) return;
  body.attachmentsOmitted += attachments.length - target;
  attachments.length = target;
}

function fitWithinBudget(body: NormalizedRfpRequestBody, budget: number, protectedCount = 0): void {
  // FIRST, and whole: the activity log is the most expendable thing in the body. It is purely
  // informational, the full history is one click away in the CRM, and it is a second UNBOUNDED input
  // alongside the description.
  //
  // The ORDER matters and is not interchangeable with SACRIFICIAL_DEAL_FIELDS: leaving it to that list
  // would shrink the DESCRIPTION — the deal's actual scope, which Procore shows as Project Description —
  // in order to preserve an activity log, which is backwards. It is `.nullable()` in SyncHub's contract,
  // so dropping it can never turn a 413 into a 422. The build-time caps in bid-board-activity-note.ts
  // (MAX_NOTE_CHARS) mean this is a rare backstop, not the normal path.
  if (body.deal?.crmActivityLog != null && serializedBytes(body) > budget) {
    const droppedChars = body.deal.crmActivityLog.length;
    body.deal.crmActivityLog = null;
    // Say so. Unlike `attachmentsOmitted` there is no field on the wire carrying this, so without a log
    // line "why did this Bid Board project get no note?" has no answer anywhere — and since the
    // build-time caps make this a rare backstop, a line here is also the signal that something upstream
    // is producing notes far larger than MAX_NOTE_CHARS.
    console.warn(
      `[RFP] Dropped crmActivityLog (${droppedChars} chars) from the body for deal ${body.sourceDealId} ` +
        `to fit the ${budget}-byte budget; the Bid Board project will get no activity note.`
    );
  }

  const original = body.deal?.description;
  if (original && serializedBytes(body) > budget) {
    // Geometric shrink: guaranteed progress, terminates in O(log n), and exactness doesn't
    // matter here — only that the result is parseable.
    let keep = original.length;
    while (keep > 0 && serializedBytes(body) > budget) {
      keep = Math.floor(keep / 2);
      body.deal.description =
        keep > 0 ? original.slice(0, keep) + DESCRIPTION_TRUNCATED_SUFFIX : DESCRIPTION_TRUNCATED_SUFFIX.trim();
    }
  }

  // Trim attachments, but never below the protected prefix: the photo share link is the ONLY route
  // to a collapsed deal's photos, so a pathological `estimator` must not be what evicts it. Oversized
  // optional deal fields are surrendered first, below.
  trimAttachmentsToBudget(body, budget, protectedCount);

  if (serializedBytes(body) <= budget) return;

  // Backstop. Shrinking only the description and the attachments is NOT a total guarantee: several
  // deal columns are unbounded `text` (estimator, property_address, property_country, project_type,
  // project_number), as are the joined company/contact names. Once the two passes above are
  // exhausted a pathological value in any of them would otherwise be returned oversized — the exact
  // 413 this cap exists to prevent.
  //
  // Give up the whole address block first (several unbounded parts, purely informational), then the
  // optional display fields in priority order.
  if (body.deal) {
    body.deal.address = null;
    for (const field of SACRIFICIAL_DEAL_FIELDS) {
      if (serializedBytes(body) <= budget) return;
      body.deal[field] = null;
    }

    body.deal.name = clampRequired(body.deal.name);
    body.deal.projectNumber = clampRequired(body.deal.projectNumber);
    body.deal.projectType = clampRequired(body.deal.projectType);
  }

  // Only fields SyncHub requires to be non-empty remain, so clamp rather than drop. Each is
  // guaranteed non-empty on the way in (name falls back to "Untitled Deal", projectNumber to the
  // deal id, projectType to a resolved code), and slicing a non-empty string keeps it non-empty —
  // this bounds the floor to a few KB, well under any sane budget.
  body.sourceDealId = clampRequired(body.sourceDealId);
  body.sourceEventId = clampRequired(body.sourceEventId);

  // Absolute last resort: with every field surrendered and still no room, the protected link has to
  // go too — an unparseable body helps nobody. Unreachable for any realistic input, since the floor
  // above is a few KB.
  if (serializedBytes(body) > budget) trimAttachmentsToBudget(body, budget, 0);
}

/**
 * Re-applies the size cap to a body whose attachments were replaced after it was first built.
 *
 * The retry route splices freshly-minted presigned URLs into the DEAD job's already-capped body.
 * Without this the limiter never runs on the new list, so a deal whose file set grew since the
 * original enqueue re-enqueues an oversized body and the worker dead-letters it with another 413.
 * Returns a new object — the caller's body (and the dead job's stored payload) is left untouched —
 * and recomputes `attachmentsOmitted` rather than inheriting the stale count.
 */
export function capRfpRequestBody(
  body: NormalizedRfpRequestBody,
  maxBodyBytes?: number
): NormalizedRfpRequestBody {
  // The retry path feeds us a body read back out of job_queue, which may predate this shape (older
  // dead jobs carry no attachmentsOmitted) — so tolerate a partial record rather than throwing and
  // turning a retry into a 500.
  // The shallow spread carries every deal field through, including crmActivityLog. A body stored before
  // that field existed simply has no key — `undefined` is treated as absent by both fitWithinBudget and
  // JSON.stringify, so an old dead job re-caps to exactly the same shape it had (never a "undefined"
  // string, never a spurious null).
  const deal = (body.deal ?? {}) as NormalizedRfpRequestBody["deal"];
  const next: NormalizedRfpRequestBody = {
    ...body,
    deal: { ...deal, address: deal.address ? { ...deal.address } : null },
    attachments: [...(body.attachments ?? [])],
    attachmentsOmitted: 0,
  };
  fitWithinBudget(next, maxBodyBytes ?? RFP_BODY_BYTE_BUDGET, protectedAttachmentCount(next.attachments));
  return next;
}

export function buildNormalizedRfpRequestBody(input: {
  deal: RfpPayloadSourceDeal;
  sourceEventId: string;
  attachments?: RfpAttachment[];
  /** Override the byte budget (tests). Defaults to RFP_BODY_BYTE_BUDGET. */
  maxBodyBytes?: number;
  /** Leading attachments the cap must preserve. Defaults to detecting the photo share link. */
  protectedAttachmentCount?: number;
}): NormalizedRfpRequestBody {
  const { deal, sourceEventId } = input;
  const body: NormalizedRfpRequestBody = {
    sourceSystem: "trock_crm",
    sourceDealId: deal.id,
    sourceEventId,
    deal: {
      name: cleanString(deal.name) ?? "Untitled Deal",
      // Ship the FORMATTED project number (canonical `project_number`, else the
      // bid-board `deal_number`) — NEVER the raw HubSpot id (resolveDealDisplayNumber
      // guards HS ids out, returning null → we fall back to the deal UUID only when
      // there is no real number yet). A voter's edited project_number flows here.
      projectNumber:
        resolveDealDisplayNumber({ projectNumber: deal.projectNumber, dealNumber: deal.dealNumber }) ??
        deal.id,
      // Same three tiers as isServiceRfp and the SQL predicate. The configured digit matters most here:
      // a deal typed only by project_type_id (the common import shape) would otherwise ship as type 9,
      // telling SyncHub a service job is residential work.
      projectType: resolveProjectTypeCode({
        projectType: deal.projectType,
        projectTypes: deal.projectTypeCode,
        workflowRoute: deal.workflowRoute ?? "normal",
      }),
      amount: resolveRfpDealAmount(deal),
      estimator: cleanString(deal.estimator) ?? cleanString(deal.bidBoardEstimator),
      ownerName: cleanString(deal.ownerName),
      ownerEmail: cleanString(deal.ownerEmail),
      companyName: cleanString(deal.companyName),
      contactName: cleanString(deal.contactName),
      clientEmail: cleanString(deal.clientEmail),
      clientPhone: cleanString(deal.clientPhone),
      address: buildAddress(deal),
      description: cleanString(deal.description),
      // Pre-rendered by loadRfpPayloadDeal; cleanString so a blank/whitespace-only render lands as null
      // (SyncHub then posts no note) rather than as an empty string.
      crmActivityLog: cleanString(deal.crmActivityLog),
      dueDate: cleanIso(deal.bidDueDate) ?? cleanIso(deal.bidBoardDueDate),
      workflowRoute: deal.workflowRoute ?? null,
    },
    attachments: [...(input.attachments ?? [])],
    attachmentsOmitted: 0,
  };

  fitWithinBudget(
    body,
    input.maxBodyBytes ?? RFP_BODY_BYTE_BUDGET,
    input.protectedAttachmentCount ?? protectedAttachmentCount(body.attachments)
  );
  return body;
}

export function buildRfpRequestDeliveryPayload(input: {
  deal: RfpPayloadSourceDeal;
  sourceEventId: string;
  syncHubUrl?: string;
  attachments?: RfpAttachment[];
}): RfpRequestDeliveryPayload {
  return {
    dealId: input.deal.id,
    syncHubUrl: input.syncHubUrl ?? resolveSyncHubRfpRequestUrl(),
    body: buildNormalizedRfpRequestBody({
      deal: input.deal,
      sourceEventId: input.sourceEventId,
      attachments: input.attachments,
    }),
  };
}
