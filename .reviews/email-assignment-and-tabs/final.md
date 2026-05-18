# Email Assignment And Tabs

## Summary

This change wires manual email association into the entity Emails tabs by:

- keeping the existing Activity entry behavior
- writing `assigned_entity_type` and `assigned_entity_id` on the email record
- adding denormalized `email_count` and `last_email_at` fields to companies, leads, deals, and contacts
- refreshing affected entity stats on assign, ignore, and un-ignore
- adding a lazy company email endpoint and enforcing mailbox-owner scoping on entity email reads
- replacing the company placeholder tab and adding count badges on company, lead, and deal detail tabs

## Local Verification

Focused verification completed:

- `npx vitest run server/tests/modules/email/service.test.ts server/tests/modules/email/routes.test.ts client/src/pages/companies/company-detail-page.test.tsx client/src/pages/leads/lead-detail-page.test.tsx client/src/pages/deals/deal-detail-page.test.tsx --testTimeout=15000`
- `npm run typecheck --workspace=server`
- `npm run typecheck --workspace=client`

Broader verification command run:

- `TMPDIR=/private/tmp npx vitest run server/tests/modules/email/ server/tests/modules/companies/ server/tests/modules/leads/ server/tests/modules/deals/ client/src/pages/companies/ client/src/pages/deals/ client/src/pages/leads/ --testTimeout=15000 --exclude '.worktrees/**'`

Broader suite result:

- unrelated pre-existing failures remain in `server/tests/modules/leads/conversion-service.test.ts`
- unrelated pre-existing failures remain in `server/tests/modules/deals/post-conversion-enrichment.test.ts`
- unrelated pre-existing failures remain in `server/tests/modules/deals/create-route.test.ts`

These failures were outside the email-assignment/tabs scope and were already red during the broader repo sweep.

## User Smoke Test

1. Go to the email parking lot.
2. Assign an email to a company.
3. Open that company’s detail page.
4. Click the Emails tab and verify the email appears.
5. Verify the same email still appears under the Activity tab.
6. Repeat the same flow for a deal and a lead.
7. Confirm the company, deal, and lead pages show the email count badge without waiting for the tab list request.
8. Confirm the email list only loads after clicking the Emails tab.
