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

/** Same app-wide money ceiling the deal PATCH enforces (validateDealPayload). Keeps the write ceiling consistent
 *  and turns a numeric(14,2) overflow into a clean 400 instead of an opaque 500. */
const MAX_EDIT_AMOUNT = 999_999_999;

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

/** Trimmed string for a field value, or "" for null/undefined/non-primitive. Rejects objects/arrays instead of
 *  coercing them ("[object Object]" / "1,2") so a raw caller can't silently save a coerced object into a text
 *  column (name/estimator/address/city/country/description). Primitives (string/number/boolean) coerce normally. */
function trimmed(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "object") return "";
  return String(value).trim();
}

function invalid(message: string): never {
  throw new AppError(400, message, "RFP_VOTE_EDIT_INVALID");
}

/** True if the string contains an ASCII control character (C0 range or DEL) — the same class the PATCH route's
 *  project-number validator rejects. Written as a scan (not a regex literal) to keep control bytes out of source. */
function containsControlChar(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
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
  deal: Pick<DealRow, "name" | "projectNumber" | "projectType" | "bidEstimate" | "awardedAmount" | "ddEstimate" | "forecastRevenue" | "estimator" | "description" | "bidDueDate" | "propertyAddress" | "propertyCity" | "propertyState" | "propertyZip" | "propertyCountry">
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

  // amount → the column the create-payload COALESCE (awarded_amount → bid_estimate → dd_estimate → forecast)
  // reads FIRST, so the edit actually reaches the Bid Board create. awarded_amount is normally null pre-award →
  // bid_estimate; but a reopened-Won / admin-set deal can carry a non-null awarded_amount, and writing bid_estimate
  // then would be masked by the awarded-first COALESCE. The form pre-fill mirrors this awarded-first precedence.
  if (has(fields, "amount")) {
    const raw = trimmed(fields.amount);
    if (raw.length > 0) {
      const cleaned = raw.replace(/[$,\s]/g, "");
      // Reject a value that was ONLY currency punctuation ("$", ",,") — cleaned is now "" and Number("") is 0,
      // which would silently write 0.00 to the deal + Bid Board payload instead of surfacing a malformed edit.
      if (cleaned.length === 0) invalid("Amount must be a number.");
      const parsed = Number(cleaned);
      if (!Number.isFinite(parsed) || parsed < 0) invalid("Amount must be a non-negative number.");
      if (parsed > MAX_EDIT_AMOUNT) invalid(`Amount must not exceed ${MAX_EDIT_AMOUNT}.`);
      const next = parsed.toFixed(2); // numeric(14,2) — Drizzle takes a string
      // Target the column the payload COALESCE actually reads first (awarded → bid → dd). The form pre-fills from
      // the SAME chain, so an untouched approve is a no-op — otherwise a dd-only deal's pre-filled amount would be
      // silently COPIED into bid_estimate just by approving. A value-less deal defaults to bid_estimate (RFP bid).
      const target =
        deal.awardedAmount != null
          ? "awardedAmount"
          : deal.bidEstimate != null
            ? "bidEstimate"
            : deal.ddEstimate != null
              ? "ddEstimate"
              : deal.forecastRevenue != null
                ? "forecastRevenue"
                : "bidEstimate";
      const existing =
        target === "awardedAmount"
          ? deal.awardedAmount
          : target === "ddEstimate"
            ? deal.ddEstimate
            : target === "forecastRevenue"
              ? deal.forecastRevenue
              : deal.bidEstimate;
      if (next !== (existing == null ? null : Number(existing).toFixed(2))) {
        updates[target] = next;
        // Mark the human override so the Procore / Bid Board mirror won't clobber the voter's correction on the next
        // sync (bid_estimate has no such flag). Mirrors updateDeal's behavior for a manual amount edit.
        if (target === "awardedAmount") updates.awardedAmountOverridden = true;
        else if (target === "ddEstimate") updates.ddEstimateOverridden = true;
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
      // Parity with the PATCH route's normalizeProjectNumberInput: reject control chars / over-length values that
      // would break URL params, exact-match lookups, CSV round-trips, and log lines.
      if (pn.length > 100) invalid("Project number must be 100 characters or fewer.");
      if (containsControlChar(pn)) invalid("Project number contains invalid characters.");
      nextNumber = pn;
    }
  }

  // The EFFECTIVE type the number's digit must reflect: the newly-submitted type when it changed, else the deal's
  // current type. `castRfpVote` resolves updates.projectTypeId from updates.projectType (mirrors updateDeal) so the
  // deals-list project_type_id filter + getDealDetail's config-name display both track the new type — this pure fn
  // only records the changed VALUE.
  let effectiveTypeValue: string | null = deal.projectType ?? null;
  if (has(fields, "project_types")) {
    const code = trimmed(fields.project_types);
    if (code.length > 0) {
      const value = PROJECT_TYPE_VALUE_BY_CODE[code];
      if (!value) invalid("Project type is not valid.");
      if (value !== deal.projectType) {
        // A REAL type change. Block changing INTO Service (option A) — an ALREADY-service open round
        // (admin-reclassified mid-round; the authz layer keeps it votable) submits an UNCHANGED "4" that hits the
        // `value === deal.projectType` skip above, so it never reaches here and can't strand.
        if (code === SERVICE_PROJECT_TYPE_CODE) {
          throw new AppError(
            409,
            "Changing this RFP to Service is not allowed here — cancel it and re-trigger it through the service flow.",
            "RFP_VOTE_SERVICE_TYPE_BLOCKED",
          );
        }
        updates.projectType = value;
      }
      effectiveTypeValue = value;
    }
  }

  // Keep the number's type digit consistent with the EFFECTIVE type (SyncHub parity: type wins the digit) whenever
  // the voter edited the number OR the type — so a number-only edit (e.g. DFW-3-… → DFW-9-… with the type left on
  // Roofing) is corrected to the type's digit instead of storing/shipping a mismatched number. Fail-soft when the
  // number isn't strict-canonical.
  if (effectiveTypeValue && (has(fields, "project_number") || has(fields, "project_types"))) {
    const rewritten = buildIntendedProjectNumber(nextNumber, effectiveTypeValue);
    if (rewritten) nextNumber = rewritten;
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
      const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
      if (!m) invalid("Bid due date must be a valid date (YYYY-MM-DD).");
      const y = Number(m![1]);
      const mo = Number(m![2]);
      const d = Number(m![3]);
      const parsed = new Date(Date.UTC(y, mo - 1, d));
      // Reject IMPOSSIBLE calendar dates: JS would roll 2026-02-31 forward to Mar 3 and quietly save a different
      // date. Require the round-trip to match the input (mirrors the normal deal-date path).
      if (parsed.getUTCFullYear() !== y || parsed.getUTCMonth() !== mo - 1 || parsed.getUTCDate() !== d) {
        invalid("Bid due date is not a real calendar date.");
      }
      const existing = deal.bidDueDate instanceof Date ? deal.bidDueDate.getTime() : deal.bidDueDate ? new Date(deal.bidDueDate).getTime() : null;
      if (parsed.getTime() !== existing) updates.bidDueDate = parsed;
    }
  }

  // Address block → property_* columns
  applyText(updates, fields, "address", deal.propertyAddress, "propertyAddress");
  // property_city is varchar(255) (the only length-bounded address column) — guard it inline so an over-length
  // value returns a clean 400 instead of a numeric/varchar 22001 overflow surfacing as a 500.
  if (has(fields, "city")) {
    const city = trimmed(fields.city);
    if (city.length > 0 && city !== (deal.propertyCity ?? "")) {
      if (city.length > 255) invalid("City must be 255 characters or fewer.");
      updates.propertyCity = city;
    }
  }
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
 * Write a prepared (already validated + diffed via buildRfpVoteDealUpdate) RFP vote edit to the `deals` row — the
 * AUTHORIZED commit point for a first-YES vote. DELIBERATELY bypasses the PATCH-route scope-lock
 * (SCOPE_READ_ONLY_AFTER_RFP): the lock lives in the route, not the column write, and the vote path has its own
 * authorization. Runs inside the vote tally transaction under the FOR UPDATE lock castRfpVote holds, so the edited
 * deal is what the deciding approve's loadRfpPayloadDeal re-reads into the Bid Board create payload. Company/contact/
 * notes are never in `updates` (linked-record / no-column context). No-op when there's nothing to write.
 *
 * The caller (castRfpVote) builds the update FIRST, so it can gate the "already locked" 409 on a REAL change — an
 * all-no-op edit set (a stale/untouched client resubmitting current values) must not bounce a late deciding approve.
 */
export async function writeRfpVoteDealUpdate(
  tenantDb: TenantDb,
  dealId: string,
  updates: Record<string, unknown>,
): Promise<void> {
  if (Object.keys(updates).length === 0) return;
  await tenantDb
    .update(deals)
    .set({ ...updates, updatedAt: new Date() })
    .where(eq(deals.id, dealId))
    .returning({ id: deals.id });
}
