# Billing address gate — design

**Date:** 2026-07-11
**Status:** approved (design)
**Depends on:** #902 (Deal Billing address capture) — builds on the inline add-contact address fields, the `billingContactAddress/City/State/Zip` projection, and the address display.

## Problem

A deal's billing requirement is satisfied as soon as *any* billing contact is assigned. But a billing contact with no address is useless for invoicing. We want: a billing contact must have a complete mailing address, and if a rep picks (or creates) a contact without one, they are forced to fill it in before the assignment is accepted.

## Decisions (locked)

- **Complete address = street + city + state + ZIP**, using the same rules as the main contact form: state `/^[A-Z]{2}$/`, ZIP `/^\d{5}(-\d{4})?$/`, street and city non-empty (trimmed).
- **Forward-only.** Enforce on new assign/create. Do **not** retroactively flag existing Won deals whose billing contact lacks an address.
- **Write the address onto the contact record** (global), not a deal-local field. Completing a billing address fills in the contact's own `address/city/state/zip`.
- **The gate computation (`billingAttentionRequired`) is unchanged.** Forward-only enforcement at assign-time means every newly-assigned contact already has an address, so the existing "missing billing contact" alert needs no change and no retroactive noise appears.

## Approach: enforce a complete address at assign-time (client + server)

### 1. Shared validator (`shared/`)
`isCompleteBillingAddress(contact)` and `getMissingBillingAddressFields(contact)` — a single source of truth used by both client and server so they never disagree. Rules as above. Mirrors the existing client `property-completeness.ts` shape.

### 2. Client — pick from search (`client/src/pages/deals/deal-billing-tab.tsx`)
Clicking a search result no longer assigns immediately:
1. Fetch `GET /contacts/:id` (returns `address/city/state/zip`).
2. If `isCompleteBillingAddress` → assign directly (one click, unchanged UX).
3. If not → open an address sub-form **pre-filled** with the contact's partial address, require the missing fields (inline errors, same messages as the contact form), `PATCH /contacts/:id` with the completed address, then assign.
Surface errors on both the contact-update and the assign steps.

### 3. Client — add new contact dialog
The dialog already collects address (from #902). Make street/city/state/ZIP **required**: Save disabled + inline errors until `isCompleteBillingAddress` passes. (Other fields stay as-is.)

### 4. Server backstop (`server/src/modules/deals/service.ts` — `updateDeal` / `validateDealBillingContact`)
When a PATCH sets `billingContactId` (`input.billingContactId !== undefined` and non-null), load the contact's address and reject with `400` ("Billing contact needs a complete address — street, city, state, and ZIP.") if `isCompleteBillingAddress` fails. Naturally forward-only (only runs when someone assigns). This guarantees the rule even if the UI is bypassed.

### 5. Gate
Unchanged.

## Side effects / notes
- Completing an address updates the shared contact record (intended, confirmed).
- A contact used as billing on multiple deals: fixing its address benefits all — expected.
- Existing deals with an address-less billing contact: left alone; no alert, no forced fix (forward-only).

## Testing
- **Shared:** unit tests for `isCompleteBillingAddress` / `getMissingBillingAddressFields` (each field missing/invalid, valid case, state/ZIP formats).
- **Client (`deal-billing-tab.test.tsx`):** pick an address-less contact → forced address form → `PATCH /contacts/:id` then assign; pick a complete contact → direct assign (no form); add-new requires a complete address before Save.
- **Server (`deals` tests):** PATCH `billingContactId` for an address-less contact → 400; for a complete contact → ok; PATCH without `billingContactId` on a deal that already has an address-less billing contact → unaffected (forward-only).

## Rejected alternatives
- **Client-only enforcement** — no server guarantee; API/other clients could bypass.
- **Make `billingAttentionRequired` require an address** — would retroactively light up existing Won deals, conflicting with the forward-only decision.
- **Deal-local billing address** — more isolated but a bigger change (new deal fields + display) and not what "populate the [contact's] address" asked for.
