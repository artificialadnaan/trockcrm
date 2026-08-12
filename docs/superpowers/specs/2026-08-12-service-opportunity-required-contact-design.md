# Require a point of contact on a new Service Opportunity

**Date:** 2026-08-12
**Status:** Approved, ready for planning

## Problem

A Service Opportunity is created with a company and a property but no person. The service crew then has
a job and an address and nobody to call. The field is imperative for them, so the create form must not
let an opportunity through without one.

## Scope

Create time only. Existing Service Opportunities are left exactly as they are — no backfill, no prompt,
no migration. The gap closes going forward.

The requirement applies to **one route and one form**. Every other way a deal is created — Bid Board
sync, RFP ingestion, HubSpot import, the generic deal form, lead conversion — is untouched.

## What already exists

Most of this is wiring, not new machinery:

- `deals.primary_contact_id` is on the schema already (`shared/src/schema/tenant/deals.ts`), nullable,
  referencing `contacts.id`.
- `POST /deals/service-opportunity` is a **dedicated route** (`server/src/modules/deals/routes.ts`). It
  already destructures `primaryContactId` and passes it to `createDeal`. It is simply optional today and
  the client never sends it.
- `createDeal` already calls `validateDealPrimaryContact`, which enforces that the contact exists, is
  active, and **belongs to the deal's company** — throwing `400 "Primary contact does not belong to the
  company"` otherwise.
- The client has `useContacts({ companyId })`, `createContact`, and `checkDuplicates` in
  `client/src/hooks/use-contacts.ts`.

## Design

### Server — one guard on one route

In the `POST /deals/service-opportunity` handler, beside the existing `"Company and property are
required"` check:

```ts
if (!primaryContactId) throw new AppError(400, "Point of contact is required");
```

That is the entire server change. `validateDealPrimaryContact` continues to do the existence, active,
and company-membership checks it already does.

**The column stays nullable.** Enforcing this at the database level would break every other deal
creation path, all of which legitimately produce contact-less deals. The requirement is a property of
*this create flow*, not of the deal record, and it is expressed where that flow lives.

### Client — a required field on the form

In `client/src/components/deals/service-opportunity-form.tsx`, a **Point of Contact** field placed
directly after Company/Property, because it depends on the company.

- The picker lists **only** the selected company's contacts, via `useContacts({ companyId })`. There is
  deliberately no "search all contacts" escape: the server rejects a contact from another company, so a
  wider list would offer choices that fail on save. The escape hatch is "Add new contact", below.
- **"Add new contact"** opens a dialog over the page. The created contact gets `companyId` pre-set to
  the selected company and is then auto-selected.
- The inline create runs `checkDuplicates` first, so the shortcut does not quietly mint a second copy of
  a person already in the CRM.
- A client-side guard mirrors the server's, following the form's existing ordered `setError` pattern:
  after the company/property check, before the assigned-rep check.

Why pre-setting the company matters: the server rejects a contact from a different company. Creating the
contact under the selected company is what makes the inline path always valid, rather than letting a rep
fill the form and eat a 400.

### Dependent state

Mirrors what the form already does with property, which is cleared when the company changes:

| Situation | Behaviour |
|---|---|
| No company chosen yet | Field disabled, "Select a company first" |
| Company changed after a contact was picked | Contact cleared |
| Selected company has no contacts | Empty state whose primary action is "Add new contact" |

### Payload

`primaryContactId` is added to `CreateServiceOpportunityInput` and sent by `createServiceOpportunity`.
It is always set by the time submit is reachable, but it must be **omitted rather than sent as `""`** if
it is ever unset — an empty string in a uuid column raises Postgres `22P02`, which has bitten this form
before.

## Testing

Every assertion below must be confirmed to **fail without the change**. Three tests today were found
passing for the wrong reason, so a green test is not evidence until it has been seen red.

**Form** (`service-opportunity-form.test.tsx`):
- Create is blocked, with the error shown, when no contact is selected.
- Changing the company clears an already-selected contact.
- A contact created through the inline dialog is auto-selected and carries the selected company.

**Server** (deals route tests):
- `POST /deals/service-opportunity` returns 400 with no `primaryContactId`.
- The generic deal create path still accepts a deal with no primary contact — the guard did not leak.

## Accepted trade-off

Picking an **existing** contact who belongs to a different company still fails the server's
company-membership check. The property-manager case is handled by creating that person under the
selected company, which duplicates someone who may already exist elsewhere in the CRM.

This was chosen deliberately over the alternatives — a new global-scope `service_contact_id` column, or
relaxing the primary-contact rule for every deal type — because it needs no migration and changes no
existing behaviour. The likely symptom is a rep asking why they cannot pick a contact they can see.

## Out of scope

- Backfilling or prompting on existing Service Opportunities.
- Any new column or migration.
- Changing primary-contact behaviour for any other deal type.
- The generic deal form, mobile, and field surfaces.
