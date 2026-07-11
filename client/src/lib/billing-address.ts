export type BillingAddressField = "address" | "city" | "state" | "zip";

export interface BillingAddressInput {
  address?: string | null;
  city?: string | null;
  state?: string | null;
  zip?: string | null;
}

function clean(value: string | null | undefined): string {
  return value?.trim() ?? "";
}

/**
 * A billing contact needs a complete US mailing address to be invoiceable: street + city non-empty, state
 * exactly two letters, ZIP 5 or 5+4. Same rules the CRM contact form enforces.
 *
 * NOTE: kept in sync with the server copy at server/src/lib/billing-address.ts — both sides must agree on
 * what "has a billing address" means (this side forces it before assigning; the server rejects an
 * incomplete one). If you change a rule here, change it there.
 */
export function getMissingBillingAddressFields(contact: BillingAddressInput): BillingAddressField[] {
  const missing: BillingAddressField[] = [];
  if (!clean(contact.address)) missing.push("address");
  if (!clean(contact.city)) missing.push("city");
  if (!/^[A-Z]{2}$/.test(clean(contact.state).toUpperCase())) missing.push("state");
  if (!/^\d{5}(-\d{4})?$/.test(clean(contact.zip))) missing.push("zip");
  return missing;
}

export function isCompleteBillingAddress(contact: BillingAddressInput): boolean {
  return getMissingBillingAddressFields(contact).length === 0;
}
