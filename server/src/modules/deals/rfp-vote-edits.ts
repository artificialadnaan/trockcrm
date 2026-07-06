import { eq } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { deals } from "@trock-crm/shared/schema";
import type * as schema from "@trock-crm/shared/schema";
import { PROJECT_TYPE_VALUE_BY_CODE } from "@trock-crm/shared/types";
import { isHubspotImportedDealNumber } from "@trock-crm/shared/types";
import { AppError } from "../../middleware/error-handler.js";
import { buildIntendedProjectNumber } from "../../services/projectNumber.js";

type TenantDb = NodePgDatabase<typeof schema>;
type DealRow = typeof deals.$inferSelect;

/** SyncHub project-type code for Service. Editing a deal INTO Service mid-round is blocked (option A):
 *  a Service RFP must go through the SyncHub service-approval path, not the CRM 3-voter round. */
const SERVICE_PROJECT_TYPE_CODE = "4";

/**
 * The SyncHub RFP-review form submits a flat map of string values keyed by these names. In the CRM v1 the
 * WRITABLE subset is the deal's own columns. Company + primary contact are LINKED records (read-only context)
 * and there is no generic `notes` column, so `company_name`, `client_email`, `client_phone`, `notes` are
 * accepted-but-ignored (never written). Any key not in the writable allowlist is silently dropped, so a caller
 * can never write an arbitrary deal column through this path.
 */
export interface RfpVoteEditableFields {
  dealname?: unknown;
  project_number?: unknown;
  amount?: unknown;
  project_types?: unknown; // "1".."9" digit (SyncHub-style)
  estimator?: unknown; // free-text display name (SyncHub parity — writes deals.estimator, not the FK)
  bid_due_date?: unknown; // YYYY-MM-DD
  address?: unknown;
  city?: unknown;
  state?: unknown;
  zip?: unknown;
  country?: unknown;
  description?: unknown;
  // Accepted but NOT written (linked-record / no-column context fields):
  company_name?: unknown;
  client_email?: unknown;
  client_phone?: unknown;
  notes?: unknown;
  [key: string]: unknown;
}

function has(fields: RfpVoteEditableFields, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(fields, key);
}

/** Trimmed string for a field value, or "" for null/undefined/non-string-coercible. */
function trimmed(value: unknown): string {
  if (value == null) return "";
  return String(value).trim();
}

function invalid(message: string): never {
  throw new AppError(400, message, "RFP_VOTE_EDIT_INVALID");
}

/**
 * PURE: map the vote form's edited fields onto a `deals`-column update object (Drizzle TS keys), applying the
 * same field allowlist + validation the authorized commit uses. Throws AppError on a blocked/invalid edit:
 *   - project_types === "4" → 409 RFP_VOTE_SERVICE_TYPE_BLOCKED
 *   - malformed amount / date / state / zip / project number → 400 RFP_VOTE_EDIT_INVALID
 * A present-but-empty value is SKIPPED (preserves the existing column — mirrors SyncHub's can't-blank-on-edit),
 * so voters can correct/replace a field but not accidentally wipe it. Returns only the columns that actually
 * change; an empty object means the edits were all no-ops.
 */
export function buildRfpVoteDealUpdate(
  fields: RfpVoteEditableFields,
  deal: Pick<DealRow, "name" | "projectNumber" | "projectType" | "bidEstimate" | "estimator" | "description" | "bidDueDate" | "propertyAddress" | "propertyCity" | "propertyState" | "propertyZip" | "propertyCountry">
): Record<string, unknown> {
  const updates: Record<string, unknown> = {};

  // name
  if (has(fields, "dealname")) {
    const name = trimmed(fields.dealname);
    if (name.length > 0 && name !== deal.name) {
      if (name.length > 500) invalid("Deal name must be 500 characters or fewer.");
      updates.name = name;
    }
  }

  // amount → bid_estimate (RFP = a bid; awarded_amount is null pre-award so bid_estimate wins the payload
  // COALESCE, and it's the semantically correct column).
  if (has(fields, "amount")) {
    const raw = trimmed(fields.amount);
    if (raw.length > 0) {
      const cleaned = raw.replace(/[$,\s]/g, "");
      const parsed = Number(cleaned);
      if (!Number.isFinite(parsed) || parsed < 0) invalid("Amount must be a non-negative number.");
      // numeric(14,2) — Drizzle takes a string. Compare against the existing numeric string.
      const next = parsed.toFixed(2);
      if (next !== (deal.bidEstimate == null ? null : Number(deal.bidEstimate).toFixed(2))) {
        updates.bidEstimate = next;
      }
    }
  }

  // project_number (direct edit) THEN project_types (may rewrite the type digit — type wins for the digit,
  // mirroring SyncHub's replaceProjectTypeInNumber on approve). Compute a single next number from both.
  let nextNumber: string | null = deal.projectNumber ?? null;
  if (has(fields, "project_number")) {
    const pn = trimmed(fields.project_number);
    if (pn.length > 0) {
      if (isHubspotImportedDealNumber(pn)) invalid("Project number cannot be a HubSpot id.");
      nextNumber = pn;
    }
  }

  if (has(fields, "project_types")) {
    const code = trimmed(fields.project_types);
    if (code.length > 0) {
      if (code === SERVICE_PROJECT_TYPE_CODE) {
        throw new AppError(
          409,
          "Changing this RFP to Service is not allowed here — cancel it and re-trigger it through the service flow.",
          "RFP_VOTE_SERVICE_TYPE_BLOCKED",
        );
      }
      const value = PROJECT_TYPE_VALUE_BY_CODE[code];
      if (!value) invalid("Project type is not valid.");
      if (value !== deal.projectType) updates.projectType = value;
      // Rewrite the type digit in the (possibly edited) canonical number; fail-soft to nextNumber when the
      // number isn't strict-canonical (legacy/HS formats keep the direct edit as-is).
      const rewritten = buildIntendedProjectNumber(nextNumber, value);
      if (rewritten) nextNumber = rewritten;
    }
  }

  if (nextNumber !== (deal.projectNumber ?? null)) {
    updates.projectNumber = nextNumber;
  }

  // estimator → free-text deals.estimator (SyncHub parity; the create payload reads estimator ?? bid_board_estimator)
  if (has(fields, "estimator")) {
    const est = trimmed(fields.estimator);
    if (est.length > 0 && est !== deal.estimator) updates.estimator = est;
  }

  // bid_due_date (YYYY-MM-DD) → bid_due_date (timestamptz, UTC midnight — matches how the detail loader reads it)
  if (has(fields, "bid_due_date")) {
    const raw = trimmed(fields.bid_due_date);
    if (raw.length > 0) {
      const iso = /^\d{4}-\d{2}-\d{2}$/.test(raw) ? `${raw}T00:00:00.000Z` : raw;
      const parsed = new Date(iso);
      if (!Number.isFinite(parsed.getTime())) invalid("Bid due date must be a valid date (YYYY-MM-DD).");
      const existing = deal.bidDueDate instanceof Date ? deal.bidDueDate.getTime() : deal.bidDueDate ? new Date(deal.bidDueDate).getTime() : null;
      if (parsed.getTime() !== existing) updates.bidDueDate = parsed;
    }
  }

  // Address block → property_* columns
  applyText(updates, fields, "address", deal.propertyAddress, "propertyAddress");
  applyText(updates, fields, "city", deal.propertyCity, "propertyCity");
  if (has(fields, "state")) {
    const st = trimmed(fields.state).toUpperCase();
    if (st.length > 0) {
      if (!/^[A-Z]{2}$/.test(st)) invalid("State must be a 2-letter code (e.g. TX).");
      if (st !== (deal.propertyState ?? "")) updates.propertyState = st;
    }
  }
  if (has(fields, "zip")) {
    const zip = trimmed(fields.zip);
    if (zip.length > 0) {
      if (zip.length > 10) invalid("Zip must be 10 characters or fewer.");
      if (zip !== (deal.propertyZip ?? "")) updates.propertyZip = zip;
    }
  }
  applyText(updates, fields, "country", deal.propertyCountry, "propertyCountry");
  applyText(updates, fields, "description", deal.description, "description");

  return updates;
}

/** Write a plain trimmed text field (skip-on-empty, skip-on-unchanged). */
function applyText(
  updates: Record<string, unknown>,
  fields: RfpVoteEditableFields,
  key: string,
  existing: string | null | undefined,
  column: string,
): void {
  if (!has(fields, key)) return;
  const value = trimmed(fields[key]);
  if (value.length > 0 && value !== (existing ?? "")) updates[column] = value;
}

/**
 * The AUTHORIZED commit point for a first-YES RFP vote's edits. Writes the vote form's edited fields directly to
 * the `deals` row, DELIBERATELY bypassing the PATCH-route scope-lock (SCOPE_READ_ONLY_AFTER_RFP) — the lock lives
 * in the PATCH route, not in the column write, and this path has its own vote authorization. Runs inside the vote
 * tally transaction, under the FOR UPDATE lock castRfpVote already holds, so the edited deal is what the deciding
 * approve's loadRfpPayloadDeal re-reads into the Bid Board create payload. Company/contact/notes are never written
 * (linked-record / no-column context). Returns whether any column changed.
 */
export async function applyRfpVoteEdits(args: {
  tenantDb: TenantDb;
  deal: DealRow;
  editedFields: RfpVoteEditableFields;
}): Promise<{ applied: boolean; updates: Record<string, unknown> }> {
  const updates = buildRfpVoteDealUpdate(args.editedFields, args.deal);
  if (Object.keys(updates).length === 0) return { applied: false, updates };
  updates.updatedAt = new Date();
  await args.tenantDb.update(deals).set(updates).where(eq(deals.id, args.deal.id)).returning({ id: deals.id });
  return { applied: true, updates };
}
