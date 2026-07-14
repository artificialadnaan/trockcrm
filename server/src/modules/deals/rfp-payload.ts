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
  workflowRoute?: WorkflowRoute | null;
  awardedAmount?: string | number | null;
  bidEstimate?: string | number | null;
  ddEstimate?: string | number | null;
  forecastRevenue?: string | number | null;
  estimator?: string | null;
  bidBoardEstimator?: string | null;
  /** Deal owner / assigned rep. Kept separate because a director/admin may request the RFP. */
  ownerName?: string | null;
  ownerEmail?: string | null;
  /** Actual user who opened this RFP cycle (`rfp_approval_requested_by`). */
  requestedByName?: string | null;
  requestedByEmail?: string | null;
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
    requestedByName: string | null;
    requestedByEmail: string | null;
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
    dueDate: string | null;
    workflowRoute: string | null;
  };
  attachments: RfpAttachment[];
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
  displayName: string;
  fileExtension: string | null;
  mimeType: string;
  r2Key: string;
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

export function buildNormalizedRfpRequestBody(input: {
  deal: RfpPayloadSourceDeal;
  sourceEventId: string;
  attachments?: RfpAttachment[];
}): NormalizedRfpRequestBody {
  const { deal, sourceEventId } = input;
  return {
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
      projectType: resolveProjectTypeCode({
        projectType: deal.projectType,
        workflowRoute: deal.workflowRoute ?? "normal",
      }),
      amount:
        cleanNumber(deal.awardedAmount) ??
        cleanNumber(deal.bidEstimate) ??
        cleanNumber(deal.ddEstimate) ??
        cleanNumber(deal.forecastRevenue),
      estimator: cleanString(deal.estimator) ?? cleanString(deal.bidBoardEstimator),
      ownerName: cleanString(deal.ownerName),
      ownerEmail: cleanString(deal.ownerEmail),
      requestedByName: cleanString(deal.requestedByName),
      requestedByEmail: cleanString(deal.requestedByEmail),
      companyName: cleanString(deal.companyName),
      contactName: cleanString(deal.contactName),
      clientEmail: cleanString(deal.clientEmail),
      clientPhone: cleanString(deal.clientPhone),
      address: buildAddress(deal),
      description: cleanString(deal.description),
      dueDate: cleanIso(deal.bidDueDate) ?? cleanIso(deal.bidBoardDueDate),
      workflowRoute: deal.workflowRoute ?? null,
    },
    attachments: input.attachments ?? [],
  };
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
