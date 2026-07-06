import { PROJECT_TYPE_OPTIONS } from "@trock-crm/shared/types";
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
  | "projectNumber"
  | "projectType"
  | "bidEstimate"
  | "ddEstimate"
  | "awardedAmount"
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
    project_number: deal.projectNumber ?? "",
    // Mirror the create-payload/email amount precedence (awarded_amount → bid_estimate → dd_estimate) so the voter
    // sees the SAME amount the invitation email shows and edits the value that actually ships.
    amount: deal.awardedAmount ?? deal.bidEstimate ?? deal.ddEstimate ?? "",
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

export function toEditedFields(f: VoteFormFields): RfpVoteEditableFields {
  return {
    dealname: f.dealname,
    project_number: f.project_number,
    amount: f.amount,
    project_types: f.project_types,
    estimator: f.estimator,
    bid_due_date: f.bid_due_date,
    address: f.address,
    city: f.city,
    state: f.state,
    zip: f.zip,
    country: f.country,
    description: f.description,
  };
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
  return Number.isFinite(n) ? `$${n.toLocaleString("en-US")}` : String(value);
}
