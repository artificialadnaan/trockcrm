# UI Bug Batch 002-007 Diagnoses

Generated: 2026-05-12
Branch: fix/ui-bug-batch-002-007

## BUG-002 - /photos/feed renders PDFs as broken images

Diagnosis:
- `/photos/feed` is implemented in `client/src/pages/photos/photo-feed-page.tsx`.
- The API already returns `mimeType`, `displayName`, `r2Key`, `externalUrl`, and `externalThumbnailUrl` for each feed photo via `client/src/hooks/use-photo-feed.ts` and `server/src/modules/files/feed-service.ts`.
- The photos tab renders every `FeedPhoto` with `<img src={thumbUrl}>` regardless of MIME type.
- The default projects tab also renders recent file IDs as `<img>` through `usePhotoIdThumbnail`, but it only receives IDs from `/api/files/photos/project-stats`, so it cannot know whether the recent item is an image or a PDF.
- Root cause: frontend media rendering assumes every file in the photo feed/category is image-displayable even though production contains PDF files categorized as photo.

Fix direction:
- Add explicit file/media kind detection from MIME type and extension.
- Render images as images.
- Render PDFs and other non-image files as file cards with icons.
- Include recent photo metadata in project stats while preserving `recentPhotoIds` for compatibility.

## BUG-003 - /admin/migration calls cleanup-office API without officeId

Diagnosis:
- Latest `origin/main` already has the intended fix pattern in `client/src/pages/admin/migration/migration-dashboard-page.tsx` and `client/src/hooks/use-migration.ts`.
- The page resolves `officeId` from selected office, active office, user's office, or first accessible office.
- `useOfficeOwnershipQueue` returns an empty queue and does not fetch when `filters.officeId` is missing.
- The API correctly rejects omitted `officeId`; the frontend should never issue that request.
- Root cause in the sweep was stale relative to current main or a race already corrected before this branch.

Fix direction:
- Add a regression test for the hook to prove no `/admin/cleanup/office` request is sent until `officeId` is resolved.

## BUG-007 - /api/deals/stages and /api/leads/stages return 500

Diagnosis:
- `server/src/modules/deals/routes.ts` has `/stages/:stageId` but no `/stages` list route.
- `server/src/modules/leads/routes.ts` has `/stages/:stageId` but no `/stages` list route.
- Because `/:id` routes exist later, `/stages` can be treated as a record ID in some route paths instead of returning a clean stage list.
- `server/src/modules/pipeline/routes.ts` already exposes `getAllStages(workflowFamily)` and supports `workflowFamily=deal`.
- Root cause: missing list routes for stage collection endpoints.

Fix direction:
- Add `/api/deals/stages` and `/api/leads/stages` list routes before parameterized routes.
- Reuse `getAllStages("deal")` and `getAllStages("lead")`.

## BUG-004 - Raw UUIDs visible on user/admin surfaces

Diagnosis:
- `/leads/:id` displays a `System IDs` rail section and falls back assigned rep display to `assignedRepId`.
- `/files` displays `file.uploadedBy`, which the API returns as a user ID in production.
- `/pipeline/hygiene` renders raw `stageId` in the card subtitle.
- `/admin/data-scrub` displays `row.userId` under the user name.
- `/admin/intervention-analytics` and related intervention components fall back to assigned user IDs when names are missing.
- Root cause: several low-visibility surfaces fall back from a display name to raw UUID fields.

Fix direction:
- Add a small display helper for UUID-like strings.
- Keep IDs available for keys/links/attributes, but replace visible UUID fallbacks with "Unknown user", "Linked internally", or stage names.
- Resolve pipeline hygiene stage names client-side from pipeline stage config.

## BUG-005 - HS-prefixed identifiers leak into operational UI

Diagnosis:
- PR #258 added `formatDealDisplayNumber` in `client/src/lib/deal-utils.ts`, and high-visibility deal surfaces already use it.
- Flagged lower-visibility routes still render `dealNumber` directly:
  - `/deals/stages/:stageId`
  - `/deals/:id/edit`
  - `/tasks`
  - `/files`
  - `/admin/ai-actions`
  - `/admin/ai-ops`
  - `/admin/procore`
  - `/admin/photo-audit`
  - `/admin/sales-process-disconnects`
  - Intervention queue/detail components used by `/admin/intervention-analytics`
- Some API responses do not include `projectNumber`; where only an HS-valued `dealNumber` is present, the existing helper correctly displays `Pending`.
- Root cause: inconsistent reuse of the display-number helper.

Fix direction:
- Reuse `formatDealDisplayNumber` at the flagged render points.
- Add `projectNumber` to server responses where the queried table already has it and doing so is small.
- Do not globally refactor unrelated deal-number rendering.
