import { PROJECT_TYPE_OPTIONS } from "@trock-crm/shared/types";
import { resolveDealDisplayNumber } from "@/lib/deal-utils";
import type { DealDetail } from "@/hooks/use-deals";

// The RFP is immutable once triggered — the vote page only DISPLAYS the deal's static snapshot. These helpers
// project a DealDetail into the read-only fields the page renders (and keep that projection unit-testable).

/** The static project fields shown read-only on the RFP vote page (the shape initFormFromDeal returns). */
interface VoteFormFields {
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

/** The deal fields the display reads — a narrow slice of DealDetail (keeps the helpers unit-testable). */
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
 *  wasn't rewritten) could show the wrong type. */
export function currentTypeCode(deal: Pick<DealFieldsForForm, "projectNumber" | "projectType">): string {
  const pt = (deal.projectType ?? "").trim().toLowerCase();
  const opt = PROJECT_TYPE_OPTIONS.find((o) => o.value === pt || o.label.toLowerCase() === pt);
  if (opt) return opt.code;
  const fromNumber = (deal.projectNumber ?? "").match(/^[A-Za-z]{2,4}-([1-9])-/);
  if (fromNumber) return fromNumber[1];
  return "";
}

/** Project a deal into the static fields the vote page displays. */
export function initFormFromDeal(deal: DealFieldsForForm): VoteFormFields {
  return {
    dealname: deal.name ?? "",
    // The FORMATTED display number (canonical project_number, else the non-HS deal_number) — mirrors the create
    // payload's resolveDealDisplayNumber, so a CRM-native deal whose real number lives in deal_number (with
    // project_number still null) shows its number instead of blank/Pending.
    project_number: resolveDealDisplayNumber({ projectNumber: deal.projectNumber, dealNumber: deal.dealNumber }) ?? "",
    // Mirror the create-payload/email amount precedence (awarded_amount → bid_estimate → dd_estimate → forecast) so
    // the voter sees the SAME amount the invitation email shows and the value that actually ships to the Bid Board.
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
