import { PROJECT_TYPE_OPTIONS } from "@trock-crm/shared/types";
import { resolveDealDisplayNumber } from "@/lib/deal-utils";
import type { DealDetail } from "@/hooks/use-deals";
import type { RfpVoteEditableFields } from "@/hooks/use-rfp-vote";

/** The editable form fields, keyed with SyncHub's review-form names (what the server's editedFields allowlist reads). */
export interface VoteFormFields {
  dealname: string;
  project_number: string;
  amount: string;
  project_types: string; // "1".."9" digit code
  estimator: string; // free-text display name
  bid_due_date: string; // YYYY-MM-DD
  address: string;
  city: string;
  state: string;
  zip: string;
  country: string;
  description: string;
}

/** The deal fields the form reads — a narrow slice of DealDetail (keeps the helpers unit-testable). */
export type DealFieldsForForm = Pick<
  DealDetail,
  | "name"
  | "dealNumber"
  | "projectNumber"
  | "projectType"
  | "bidEstimate"
  | "ddEstimate"
  | "awardedAmount"
  | "forecastRevenue"
  | "estimator"
  | "bidDueDate"
  | "propertyAddress"
  | "propertyCity"
  | "propertyState"
  | "propertyZip"
  | "propertyCountry"
  | "description"
>;

/** Current project-type code. deals.project_type is AUTHORITATIVE (matches resolveProjectTypeCode, the invitation
 *  email, and the create payload). Fall back to the project_number's type digit only when project_type is
 *  absent/unmappable — otherwise a stale number digit (a HubSpot-imported or since-retyped deal whose issued number
 *  wasn't rewritten) could silently reclassify project_type on an untouched approve, or block a legit non-service
 *  approve when the stale digit is 4. */
export function currentTypeCode(deal: Pick<DealFieldsForForm, "projectNumber" | "projectType">): string {
  const pt = (deal.projectType ?? "").trim().toLowerCase();
  const opt = PROJECT_TYPE_OPTIONS.find((o) => o.value === pt || o.label.toLowerCase() === pt);
  if (opt) return opt.code;
  const fromNumber = (deal.projectNumber ?? "").match(/^[A-Za-z]{2,4}-([1-9])-/);
  if (fromNumber) return fromNumber[1];
  return "";
}

export function initFormFromDeal(deal: DealFieldsForForm): VoteFormFields {
  return {
    dealname: deal.name ?? "",
    // Seed with the FORMATTED display number (canonical project_number, else the non-HS deal_number) — mirrors the
    // create payload's resolveDealDisplayNumber, so a CRM-native deal whose real number lives in deal_number (with
    // project_number still null) shows its number instead of blank/Pending in the form.
    project_number: resolveDealDisplayNumber({ projectNumber: deal.projectNumber, dealNumber: deal.dealNumber }) ?? "",
    // Mirror the create-payload/email amount precedence (awarded_amount → bid_estimate → dd_estimate → forecast) so
    // the voter sees the SAME amount the invitation email shows and edits the value that actually ships.
    amount: deal.awardedAmount ?? deal.bidEstimate ?? deal.ddEstimate ?? deal.forecastRevenue ?? "",
    project_types: currentTypeCode(deal),
    estimator: deal.estimator ?? "",
    bid_due_date: deal.bidDueDate ? deal.bidDueDate.slice(0, 10) : "", // ISO UTC -> YYYY-MM-DD
    address: deal.propertyAddress ?? "",
    city: deal.propertyCity ?? "",
    state: deal.propertyState ?? "",
    zip: deal.propertyZip ?? "",
    country: deal.propertyCountry ?? "",
    description: deal.description ?? "",
  };
}

/** Only the fields the voter ACTUALLY changed from the initial pre-fill (SyncHub-style keys), or null if none. The
 *  form always renders the full field set, but sending only changed fields prevents a stale page (opened before
 *  another voter's first approval) from submitting the whole old form and getting a spurious RFP_VOTE_ALREADY_LOCKED
 *  — an untouched approve then carries no edits and records a plain vote. */
export function diffEditedFields(current: VoteFormFields, initial: VoteFormFields): RfpVoteEditableFields | null {
  const changed: RfpVoteEditableFields = {};
  (Object.keys(current) as (keyof VoteFormFields)[]).forEach((key) => {
    if (current[key] !== initial[key]) changed[key] = current[key];
  });
  return Object.keys(changed).length > 0 ? changed : null;
}

/** Office-agnostic type-digit rewrite for the live number preview. Mirrors the server's replaceProjectTypeInNumber;
 *  the server re-applies the authoritative rewrite on commit. Leaves non-canonical numbers untouched. */
export function rewriteProjectNumberType(projectNumber: string, code: string): string {
  if (!code) return projectNumber;
  return projectNumber.replace(/^([A-Za-z]{2,4}-)\d+(-)/, `$1${code}$2`);
}

export function labelForTypeCode(code: string): string {
  return PROJECT_TYPE_OPTIONS.find((o) => o.code === code)?.label ?? "—";
}

export function formatMoney(value: string | null | undefined): string {
  if (!value) return "—";
  const n = Number(value);
  // Always show cents so currency renders consistently (125000.5 → "$125,000.50", not "$125,000.5").
  return Number.isFinite(n)
    ? `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
    : String(value);
}
