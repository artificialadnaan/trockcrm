# Deal Reassignment Build Report

## Authorization Check

Deal reassignment remains the existing `assignedRepId` PATCH path, but now has an explicit authorization gate. A reassignment is allowed only when the caller is an admin, a director, or the deal's current assigned rep. Non-owner reps are rejected with the typed authorization error `DEAL_REASSIGNMENT_FORBIDDEN`, not a generic 500.

The check exists at the route level for the assignment-only PATCH path and at the `updateDeal` service level so the rule holds for callers that reach the full update path through another server entry point.

## Full Audited Path

Reassignment continues to call the full `updateDeal` flow. The implementation does not use the sales-review reassignment shortcut. Successful reassignment therefore preserves the existing side effects:

- audit/activity logging
- `deal_history` audit row
- "New Deal Assignment" task
- queued `deal.assignment.changed` domain event

## `/users/sales-reps`

Existing consumers were checked with `rg "useSalesReps\\(" client/src -n`.

Consumers found:

- `client/src/components/reports/report-filter-bar.tsx` uses default behavior and remains unchanged.
- `client/src/components/leads/lead-form.tsx` uses default behavior and remains unchanged.
- `client/src/components/deals/deal-overview-tab.tsx` now opts into reassignment mode only when the assignment control is actionable.
- `client/src/pages/deals/deal-detail-page.tsx` now opts into reassignment mode only when the viewer can reassign the deal.

The default `/users/sales-reps` behavior is preserved, including the current narrow response for non-admin sales reps. A new explicit `purpose=deal-reassignment` query parameter returns active same-office CRM users for deal reassignment. The response excludes inactive users and access-only cross-office users so the picker does not offer targets the server reassignment path would reject.

## Owner-Facing UI

The deal detail right rail now shows an owner reassignment select for admins, directors, and the current assigned rep. Non-owner non-admin users do not get an actionable reassignment control, and the widened reassignment sales-rep query is disabled for them.

The existing deal overview assignment card also opts into the reassignment sales-rep list for users who can edit assignment, including directors.

## Same-Office Enforcement

The server validates the target assignee before changing `assignedRepId`. Target users must be active CRM users and must belong to the same office as the deal. When the deal has an `officeCode`, that deal office is authoritative. Reassignment to a different-office user is rejected with `DEAL_REASSIGNMENT_OFFICE_MISMATCH`.

## Tests

Focused tests passed:

- `TMPDIR=/private/tmp npx vitest run server/tests/modules/deals/reassignment.test.ts server/tests/modules/deals/patch-route.test.ts server/tests/modules/users/routes.test.ts --testTimeout=15000 --exclude '.worktrees/**'`
- `TMPDIR=/private/tmp npx vitest run client/src/hooks/use-sales-reps.test.ts client/src/components/reports/report-filter-bar.test.tsx client/src/components/deals/deal-form.behavior.test.tsx --testTimeout=15000 --exclude '.worktrees/**'`
- `TMPDIR=/private/tmp npx vitest run client/src/pages/deals/deal-detail-page.test.tsx -t "deal reassignment control|non-owner rep|directors" --testTimeout=15000 --exclude '.worktrees/**'`
- `npm run typecheck`

Required full-suite command was run:

`TMPDIR=/private/tmp npx vitest run server/tests/ client/src/ shared/ --testTimeout=15000 --exclude '.worktrees/**'`

Result: failed with existing unrelated failures. Summary from the run: 51 failed files, 475 passed files, 331 failed tests, 3674 passed tests, 4005 total tests, and 251 errors.

Pre-existing/unrelated failure buckets observed include sandbox/auth `listen EPERM` and null server port failures, known deal list/detail workspace tests, photo schema/audit tests, properties/sales-review related tests, lead form tests, and other broad-suite failures outside this change. Focused reassignment, sales-reps, and affected client hook/page tests passed.

## Review Rounds

Round 1, Gauss: found that `/users/sales-reps?purpose=deal-reassignment` could include access-only cross-office users and that one users route branch missed a transaction commit. Fixes applied: same-office filtering now requires `user.officeId === officeId`, the branch commits before responding, and tests cover both.

Round 2, Gibbs: found directors were missing from an existing overview assignment card and that non-actionable users could still trigger the widened sales-rep fetch. Fixes applied: directors can edit assignment where appropriate, and reassignment-purpose hooks are gated by `enabled` checks.

Round 3, Planck: found same-office validation should use the deal's office when available, not only the current owner or request office fallback, and that an editable overview card could fall back to generic task assignees. Fixes applied: service validation resolves the existing deal `officeCode` against the target user's primary office, and editable assignment controls use the reassignment sales-rep list only.
