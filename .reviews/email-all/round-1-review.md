Review source note: `.reviews/round-1-diff.patch` is 0 bytes in this worktree, so this review used the current unstaged worktree diff instead.

# Round 1 Review: Email Inbox 7-Bug Fix

Verification run:

- `npx vitest run client/src/pages/email/email-inbox-page.test.tsx server/tests/modules/email/routes.test.ts` passed: 35 tests.
- `npx vitest run server/tests/modules/email/service.test.ts` passed: 18 tests.

## Bug 1: Manual Reassignment Removed For Emails Without Conversation IDs

Status: Fixed

The inbox reader now shows `Reassign email` when `email.graphConversationId` is absent, and uses the existing manual assignment dialog plus `associateEmailToEntity` for the mutation. See `client/src/pages/email/email-inbox-page.tsx:463` and `client/src/pages/email/email-inbox-page.tsx:475`.

Implementation correctness: This fixes the reported standalone-email gap. The existing thread tools path remains available for conversation-backed emails at `client/src/pages/email/email-inbox-page.tsx:463`.

Edge cases / regressions: The standalone action is rendered for every email without a Graph conversation id, including already-linked standalone messages. That may be acceptable because the label is "Reassign", but it is broader than only "unassigned standalone emails".

Tests: Adequate for the main regression. `client/src/pages/email/email-inbox-page.test.tsx:432` proves a standalone message can open manual assignment and calls `associateEmailToEntity` with the selected target. `client/src/pages/email/email-inbox-page.test.tsx:444` proves conversation-backed emails still show thread tools.

## Bug 2: Two `useGraphAuth` Instances Diverge

Status: Fixed

The page creates one `graphAuth` state with `useGraphAuth()` and passes it into the banner at `client/src/pages/email/email-inbox-page.tsx:503` and `client/src/pages/email/email-inbox-page.tsx:595`. `GraphAuthBanner` accepts an optional shared auth prop and only falls back to its own hook when no prop is supplied at `client/src/components/email/graph-auth-banner.tsx:5`.

Implementation correctness: Correct for the inbox page. Existing external callers still work because the banner keeps a backwards-compatible no-prop path.

Edge cases / regressions: No obvious runtime regression. The test mocks `GraphAuthBanner`, so it verifies prop passing but does not verify that the real banner avoids its own hook when `auth` is supplied.

Tests: Mostly adequate. `client/src/pages/email/email-inbox-page.test.tsx:395` checks that the page passes auth state into the banner, but a direct `GraphAuthBanner` test would be stronger.

## Bug 3: Filter Applied Client-Side On Paginated Data

Status: Fixed

The page now passes `filter` into `useUserEmails` at `client/src/pages/email/email-inbox-page.tsx:508`, the hook serializes it into `/email` query params at `client/src/hooks/use-emails.ts:113`, the route forwards it at `server/src/modules/email/routes.ts:108`, and the service applies it before `count`, `limit`, and `offset` at `server/src/modules/email/service.ts:1211`.

Implementation correctness: Correct for the original paginated-data issue. `visibleEmails` no longer re-filters a page slice except for the parking-lot tab split at `client/src/pages/email/email-inbox-page.tsx:516`.

Edge cases / regressions: The route casts `req.query.filter` without runtime validation at `server/src/modules/email/routes.ts:110`. An invalid external value silently behaves like `all` because `applyInboxFilter` ignores unknown values at `server/src/modules/email/service.ts:102`. This is not a UI regression, but it weakens the API contract.

Tests: UI and route coverage are adequate for wiring. `client/src/pages/email/email-inbox-page.test.tsx:404` verifies active filters are passed to `useUserEmails`; `server/tests/modules/email/routes.test.ts:274` verifies the route forwards `filter`. There is no service-level test proving the Drizzle `where` for `filter=unassigned` or `filter=sent` is applied before pagination.

## Bug 4: Forward Button Has No Handler

Status: Fixed

Forward now opens compose with a `Fwd:` subject and quoted original body through `handleForward` at `client/src/pages/email/email-inbox-page.tsx:549`; the button calls it at `client/src/pages/email/email-inbox-page.tsx:459`. Compose accepts `defaultSubject` and `defaultBody` at `client/src/components/email/email-compose-dialog.tsx:18` and hydrates the fields at `client/src/components/email/email-compose-dialog.tsx:42`.

Implementation correctness: Correct for the requested behavior. `defaultTo` is omitted for forwards, so the To field opens empty.

Edge cases / regressions: `buildForwardBody` converts sanitized HTML to plain text at `client/src/pages/email/email-inbox-page.tsx:100`, which is appropriate for the existing plain-text textarea compose UI. It does not preserve rich formatting, attachments, or CC metadata, but those were not part of the requested fix.

Tests: Mostly adequate. `client/src/pages/email/email-inbox-page.test.tsx:453` checks subject and quoted body. It does not explicitly assert empty To, so a future regression could accidentally prefill recipients while this test still passes.

## Bug 5: Counts Derived From Page Slice, Not Full Dataset

Status: Fixed

The backend now returns `counts` from `getUserEmails` at `server/src/modules/email/service.ts:1217`, and the page reads `inboxCounts` instead of deriving metrics from `emails.length` at `client/src/pages/email/email-inbox-page.tsx:519`.

Implementation correctness: The counts are authoritative for the current base query: current user, active inbox items, optional direction, and search. The selected tab filter affects `pagination.total` and returned rows, while the count badges remain full-query counts across tabs.

Edge cases / regressions: The counts query relies on raw SQL filter expressions such as `count(*) FILTER (WHERE ${emailIsUnassignedCondition()})` at `server/src/modules/email/service.ts:1222`. The existing service tests do not execute this against a database, so SQL-shape correctness is not covered by the current tests.

Tests: UI and route coverage are partially adequate. `client/src/pages/email/email-inbox-page.test.tsx:421` proves the page uses backend counts. `server/tests/modules/email/routes.test.ts:274` proves counts pass through the route. Missing: service-level regression coverage for count semantics under search/filter and active archived/deleted exclusions.

## Bug 6: Star / Archive / Delete Reader Buttons Have No Handlers

Status: Partially Fixed

The buttons now call `updateEmailAction` at `client/src/pages/email/email-inbox-page.tsx:304`, and the backend exposes `PATCH /api/email/:id/actions` at `server/src/modules/email/routes.ts:272`. The service persists `isStarred`, `archivedAt`, and `deletedAt` at `server/src/modules/email/service.ts:1258`. Schema and migration support were added at `shared/src/schema/tenant/emails.ts:27` and `migrations/0108_email_inbox_actions.sql:38`.

Implementation correctness: Star/archive/delete now have real handlers and persistence. Rep ownership is enforced before mutation at `server/src/modules/email/service.ts:1265`.

Blocking concern: `activeEmailConditions()` was applied to the shared `getEmails` helper at `server/src/modules/email/service.ts:1040`, which backs deal and contact email endpoints via `server/src/modules/email/routes.ts:140` and `server/src/modules/email/routes.ts:159`. As written, archiving a linked email from the inbox also hides it from deal/contact email history, not just the inbox. That is a likely CRM history regression unless the intended product behavior is that Archive removes the email from every email-list surface. At minimum, this needs an explicit decision and tests for deal/contact email visibility after archive/delete.

Edge cases / regressions: There is no restore/unarchive UI or archive view. Delete has a confirm at `client/src/pages/email/email-inbox-page.tsx:305`, but archive has no confirmation and can remove linked correspondence from all `getEmails` consumers because of the shared active filter.

Tests: UI and route tests cover the happy path. `client/src/pages/email/email-inbox-page.test.tsx:465` verifies the three button calls. `server/tests/modules/email/routes.test.ts:307` verifies route dispatch. Missing: service tests for permission behavior, actual update payloads, archived/deleted exclusion, and whether deal/contact endpoints should include archived emails.

## Bug 7: Reader Email Selection From Full List, Not Filtered List

Status: Fixed

`selectedEmail` now resolves from `visibleEmails` at `client/src/pages/email/email-inbox-page.tsx:517`, and the effect resets selection when the selected id is not present in the visible list at `client/src/pages/email/email-inbox-page.tsx:532`.

Implementation correctness: Correct. It also handles the parking-lot tab by setting `visibleEmails` to an empty list.

Edge cases / regressions: No obvious regression. The effect depends on `visibleEmails`, so it will reset when server-filtered results change.

Tests: Adequate for the regression. `client/src/pages/email/email-inbox-page.test.tsx:479` verifies that switching to Sent moves the reader to the visible sent email instead of keeping the previously selected inbound email.

## Blocking Issues

- Confirm and fix archive visibility semantics before merge: `server/src/modules/email/service.ts:1040` filters archived/deleted records out of `getEmails`, which is used by deal/contact email endpoints at `server/src/modules/email/routes.ts:140` and `server/src/modules/email/routes.ts:159`. If Archive is intended to mean "remove from inbox", do not apply `activeEmailConditions()` to deal/contact history, or add an explicit `includeArchived` contract and tests.

## Non-Blocking Suggestions

- Add runtime validation for `filter` in `server/src/modules/email/routes.ts:110`; invalid filter values should 400 instead of silently behaving like `all`.
- Replace newly introduced `any[]` condition typing in `server/src/modules/email/service.ts:102`, `server/src/modules/email/service.ts:1040`, `server/src/modules/email/service.ts:1195`, and `server/src/modules/email/service.ts:1211` with a Drizzle SQL condition type if practical. The file already has legacy `any` usage, but this change adds more.
- Add service-level tests for `getUserEmails` filter/count query semantics, especially `filter=sent`, `filter=unassigned`, search-scoped counts, and archived/deleted exclusions.
- Extend the forward test at `client/src/pages/email/email-inbox-page.test.tsx:453` to explicitly assert that `defaultTo` remains empty for forwards.
- Add a direct `GraphAuthBanner` test proving the supplied `auth` prop path does not call `useGraphAuth`.
