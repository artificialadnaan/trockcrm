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
 * The mailing-address fields to absorb from `loser` into `winner` when merging contacts.
 *  - Winner's address incomplete but loser's complete → absorb the loser's FULL address as a unit, so a billing
 *    contact can't be left with a partial/mixed address.
 *  - Otherwise → fill only the winner's individually-empty fields from the loser, so a merge never DISCARDS the
 *    loser's partial address data (this is the general fill-missing-fields behavior).
 * Returns only the fields to set (an empty object when there's nothing to absorb).
 */
export function billingAddressToAbsorb(
  winner: BillingAddressInput,
  loser: BillingAddressInput,
): Partial<Record<BillingAddressField, string | null>> {
  if (!isCompleteBillingAddress(winner) && isCompleteBillingAddress(loser)) {
    return { address: loser.address ?? null, city: loser.city ?? null, state: loser.state ?? null, zip: loser.zip ?? null };
  }
  const fill: Partial<Record<BillingAddressField, string | null>> = {};
  if (!clean(winner.address) && clean(loser.address)) fill.address = loser.address ?? null;
  if (!clean(winner.city) && clean(loser.city)) fill.city = loser.city ?? null;
  if (!clean(winner.state) && clean(loser.state)) fill.state = loser.state ?? null;
  if (!clean(winner.zip) && clean(loser.zip)) fill.zip = loser.zip ?? null;
  return fill;
}
