# Round 2 Review

## Blocking Issues

None found in this diff.

## Bug-by-Bug Status

1. **Fixed - standalone emails without `graphConversationId` still have manual reassignment.**
   - `client/src/pages/email/email-inbox-page.tsx:463-472` now shows `Thread tools` only when `email.graphConversationId` exists and otherwise exposes `Reassign email`.
   - `client/src/pages/email/email-inbox-page.tsx:475-485` reuses `EmailManualAssignmentDialog` and calls `associateEmailToEntity(email.id, target)`, then refreshes the inbox.
   - The existing generic association endpoint still supports non-thread email reassignment through `server/src/modules/email/routes.ts:329-420`.

2. **Fixed - email page and `GraphAuthBanner` no longer create diverging auth state on the inbox page.**
   - `client/src/pages/email/email-inbox-page.tsx:503-504` creates one `graphAuth` state object.
   - `client/src/pages/email/email-inbox-page.tsx:567-570` and `client/src/pages/email/email-inbox-page.tsx:595` both consume that same object.
   - `client/src/components/email/graph-auth-banner.tsx:5-16` accepts an injected `GraphAuthState`. The fallback hook at `client/src/components/email/graph-auth-banner.tsx:10-12` preserves other existing callers such as `client/src/components/email/deal-email-tab.tsx:37` and `client/src/components/email/contact-email-tab.tsx:37`, so this avoids a broader hook-caller break.

3. **Fixed - inbox filters are passed to `useUserEmails` and applied server-side before pagination.**
   - The page passes `filter`, `search`, `page`, and `limit` into `useUserEmails` at `client/src/pages/email/email-inbox-page.tsx:508-514`; the visible list is no longer client-filtering a paginated slice except for the special parking-lot view at `client/src/pages/email/email-inbox-page.tsx:516`.
   - The hook serializes `filter` to `/email` query params at `client/src/hooks/use-emails.ts:113-123`.
   - The route forwards `filter` to the service at `server/src/modules/email/routes.ts:108-116`.
   - The service applies the selected inbox filter before the count and page query at `server/src/modules/email/service.ts:1211-1239`.

4. **Fixed - Forward opens compose with empty To, `Fwd:` subject, and quoted original body.**
   - Forward defaults are built without a `to` field at `client/src/pages/email/email-inbox-page.tsx:549-554`.
   - `buildForwardSubject` adds `Fwd:` unless already forwarded at `client/src/pages/email/email-inbox-page.tsx:95-98`.
   - `buildForwardBody` includes forwarded-message metadata and the sanitized/plain original body at `client/src/pages/email/email-inbox-page.tsx:100-120`.
   - `EmailComposeDialog` resets `to` to `defaultTo ?? ""`, so the forwarded compose opens with an empty To field at `client/src/components/email/email-compose-dialog.tsx:42-49`.

5. **Fixed - counts are authoritative backend counts, not current page slice counts.**
   - `getUserEmails` now returns `counts` from backend aggregate queries at `server/src/modules/email/service.ts:1217-1255`.
   - The client hook stores backend counts at `client/src/hooks/use-emails.ts:98-145`.
   - The page metrics and tab badges read `inboxCounts` rather than deriving from `emails.length` at `client/src/pages/email/email-inbox-page.tsx:519-529` and `client/src/pages/email/email-inbox-page.tsx:597-650`.

6. **Fixed - Star/Archive/Delete have handlers and persistence, and archive/delete only hide inbox rows.**
   - Reader action buttons call `updateEmailAction` for star/archive/delete at `client/src/pages/email/email-inbox-page.tsx:304-324` and are wired with labels/pressed state at `client/src/pages/email/email-inbox-page.tsx:355-385`.
   - The client mutation calls `PATCH /email/:id/actions` at `client/src/hooks/use-emails.ts:300-308`.
   - The route validates that at least one boolean action is present and calls the service at `server/src/modules/email/routes.ts:272-301`.
   - The service persists `isStarred`, `archivedAt`, and `deletedAt` at `server/src/modules/email/service.ts:1258-1286`.
   - Inbox reads exclude archived/deleted rows via `activeEmailConditions` in `getUserEmails` at `server/src/modules/email/service.ts:113-115` and `server/src/modules/email/service.ts:1195-1215`.
   - Deal/contact history uses shared `getEmails` from `server/src/modules/email/service.ts:1030-1106`, and no active archived/deleted predicate is added there unless a caller explicitly supplied an inbox filter. The deal/contact routes do not pass inbox `filter` at `server/src/modules/email/routes.ts:132-140` and `server/src/modules/email/routes.ts:151-159`.

7. **Fixed - selected reader email resolves from the visible filtered list.**
   - `selectedEmail` now resolves from `visibleEmails`, not raw `emails`, at `client/src/pages/email/email-inbox-page.tsx:516-517`.
   - The selection reset also checks membership in `visibleEmails` at `client/src/pages/email/email-inbox-page.tsx:532-535`.

8. **Fixed - Round 1 blocker: archived/deleted filtering was removed from shared deal/contact history.**
   - `activeEmailConditions` is used only by `getUserEmails` at `server/src/modules/email/service.ts:1195`; shared `getEmails` at `server/src/modules/email/service.ts:1030-1106` does not add `archivedAt`/`deletedAt` predicates by default.
   - The service regression specifically checks that deal/contact history where clauses do not reference `archived_at` or `deleted_at` at `server/tests/modules/email/service.test.ts:275-305`.

## Non-Blocking Suggestions

- `server/src/modules/email/routes.ts:108-116` casts `req.query.filter` directly to the filter union. Unknown values are ignored by `applyInboxFilter` at `server/src/modules/email/service.ts:102-110`, so behavior is safe-ish, but an explicit 400 would make the API contract tighter and avoid silent client bugs.
- The current code treats `unread` as the same predicate as `unassigned` at `server/src/modules/email/service.ts:108-110`. That matches the existing UI's prior `needsAttention` behavior, but if true read/unread state is expected later, this should be renamed or backed by a real read-state column.
- Filter tab buttons expose visual selected state but not `aria-pressed`/`aria-current` at `client/src/pages/email/email-inbox-page.tsx:631-650`. The reader action buttons are labelled, but the filter tabs would be clearer for assistive tech with an explicit active-state attribute.

## Verification

- `npm run typecheck` - passed.
- `npx vitest run client/src/pages/email/email-inbox-page.test.tsx server/tests/modules/email/routes.test.ts server/tests/modules/email/service.test.ts` - passed, 54 tests.
