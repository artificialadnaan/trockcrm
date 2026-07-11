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
 * NOTE: kept in sync with the client copy at client/src/lib/billing-address.ts — both sides must agree on
 * what "has a billing address" means (the client forces it before assigning; the server rejects an
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

/**
 * True when applying `updates` to `existing` would turn a COMPLETE billing address into an incomplete one.
 * Only a complete -> incomplete transition counts: an already-incomplete address isn't forced to be cleaned up
 * (forward-only), and an update that doesn't touch the address never breaks it. Used to stop a contact edit
 * from stripping the address off a contact that's actively the billing contact on a deal.
 */
export function updateBreaksBillingAddress(existing: BillingAddressInput, updates: Record<string, unknown>): boolean {
  if (!isCompleteBillingAddress(existing)) return false;
  const touchesAddress = (["address", "city", "state", "zip"] as const).some((k) => k in updates);
  if (!touchesAddress) return false;
  const resulting: BillingAddressInput = {
    address: "address" in updates ? (updates.address as string | null) : existing.address,
    city: "city" in updates ? (updates.city as string | null) : existing.city,
    state: "state" in updates ? (updates.state as string | null) : existing.state,
    zip: "zip" in updates ? (updates.zip as string | null) : existing.zip,
  };
  return !isCompleteBillingAddress(resulting);
}

/**
 * When merging contacts: if the winner's mailing address is incomplete but the loser's is complete, returns the
 * loser's full address to absorb as a UNIT (so a merge can't leave a billing contact with a partial/incomplete
 * address, and the two addresses aren't mixed field-by-field). Otherwise null (keep the winner's).
 */
export function billingAddressToAbsorb(
  winner: BillingAddressInput,
  loser: BillingAddressInput,
): { address: string | null; city: string | null; state: string | null; zip: string | null } | null {
  if (!isCompleteBillingAddress(winner) && isCompleteBillingAddress(loser)) {
    return { address: loser.address ?? null, city: loser.city ?? null, state: loser.state ?? null, zip: loser.zip ?? null };
  }
  return null;
}
