# Track F1 Internal Review - Iteration 1

## Diff

Changed files:

- `client/src/pages/email/email-inbox-page.tsx`
- `client/src/pages/email/email-inbox-page.test.tsx`

Summary:

- Replaced the old single-column Email page wrapper with a preview-style hero, 3 metric cards, folder tabs, search, two-pane thread list/reader, and bottom assignment queue.
- Preserved the real `useUserEmails` data flow with the existing `direction`, `search`, `page`, and `limit` filters.
- Preserved `GraphAuthBanner`, `EmailAssignmentQueue`, `EmailComposeDialog`, and `EmailThreadView` access for existing email connection, assignment, compose, and thread-assignment workflows.
- Added page-level regression tests for list/reader rendering, selection, folder tabs, search, unread/attention indicator, and reply compose.

## Test Results

- `npx vitest run client/src/pages/email/email-inbox-page.test.tsx`: 6 passed.
- `npm run typecheck`: passed.
- `ls client/src/pages/email/*.test.tsx client/src/components/email/*.test.tsx 2>/dev/null | xargs -r npx vitest run`: 11 passed across 3 files.

## Structural Decisions

- Kept the redesign inside `EmailInboxPage` rather than modifying reusable email components used by detail tabs.
- The reader uses sanitized `bodyHtml`/`bodyPreview` and keeps thread assignment behind a `Thread tools` action when `graphConversationId` exists.
- The preview's unread concept is approximated with the currently exposed CRM attention signal because the email API does not expose read/unread state.

## Concerns For Review

- Confirm no old callback/status behavior was accidentally removed.
- Confirm the top Microsoft action is not decorative-only.
- Confirm the hidden thread tools affordance is enough to preserve existing thread assignment functionality.
