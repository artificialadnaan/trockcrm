# Files Page Bug Fix Review - Round 1

## Task

Fix all 8 Codex-flagged files page bugs:

1. Photos tab must include category=photo OR image MIME files.
2. Type chips must use canonical FILE_CATEGORIES.
3. All Types must reset the tab to all.
4. Linked type must include Procore and change-order associations.
5. Linked filtering must be server-side, not applied only to the first 200 rows.
6. Library KPIs must be office-wide, not collapsed by current filters.
7. Documents tab filtering must be server-side, not applied only to the first 200 rows.
8. Grid/list view buttons need aria-pressed.

## Diff

See `.reviews/round-1-diff.patch`.

## Structural Decisions

- Added `fileKind=photos|documents` to `/api/files` so tab filters happen in the database.
- Added `linkedType=deal|lead|contact|procore|change_order|unassigned` to `/api/files` so linked filters happen in the database.
- Added `/api/files/stats` and `useFileStats()` for unfiltered office-wide library KPIs.
- Kept existing client-side filters as defensive filtering after the server-side query.
- Generated type chips from `FILE_CATEGORIES` instead of a hardcoded subset.
- Kept upload/download/delete behavior intact.

## Verification

- `npx vitest run client/src/pages/files/files-page.test.tsx`: 14 passed.
- `npx vitest run server/tests/modules/files/audit-routes.test.ts`: 7 passed.
- `npm run typecheck`: passed.
- `ls client/src/pages/files/*.test.tsx client/src/components/files/*.test.tsx 2>/dev/null | xargs -r npx vitest run`: 20 passed.
- `ls server/tests/modules/files/*.test.ts 2>/dev/null | xargs -r npx vitest run`: 64 passed.

## Concerns

- `GET /api/files/stats` is restricted to directors/admins, matching the global browser page restriction for reps.
- The server-side document filter defines documents as not `(category=photo OR mimeType ILIKE image/%)`, matching the page logic.
- I updated `photo-schema-foundation.test.ts` to include the existing schema enum value `procore_sync_retry_requested`; this was a pre-existing stale expectation discovered by the full files test sweep.
