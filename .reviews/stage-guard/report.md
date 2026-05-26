# Stage Write Guard Report

## Read-only stage write inventory

Active vs. inactive stages are distinguished by `public.pipeline_stage_config.is_active_pipeline`, exposed in Drizzle and client code as `pipelineStageConfig.isActivePipeline` / `PipelineStage.isActivePipeline`.

Normal request-scoped deal stage write paths found before implementation:

- `POST /api/deals` in `server/src/modules/deals/routes.ts` calls `createDeal()` with the request `stageId`. `createDeal()` in `server/src/modules/deals/service.ts` writes `deals.stage_id` on insert.
- `POST /api/deals/service-opportunity` in `server/src/modules/deals/routes.ts` creates a service opportunity with the canonical `opportunity` stage resolved from pipeline config, then calls `createDeal()`.
- `PATCH /api/deals/:id` in `server/src/modules/deals/routes.ts` calls `updateDeal()` for field edits. `UpdateDealInput` does not include `stageId`, and `updateDeal()` does not add `stageId` to its update object.
- `POST /api/deals/:id/stage` in `server/src/modules/deals/routes.ts` calls `changeDealStage()` in `server/src/modules/deals/stage-change.ts`, which updates `deals.stage_id` and writes `deal_stage_history`.
- `POST /api/deals/:id/stage/preflight` calls `preflightStageCheck()` / `validateStageGate()` for validation only. It does not write `deals.stage_id`, but it is the preflight counterpart to the stage-change write path.

Stage reads that must continue to include inactive stages:

- `GET /api/deals/:id` and `GET /api/deals/:id/detail` join/resolve current stage metadata for display.
- `GET /api/deals/stages` and `GET /api/pipeline/stages` list stage config for UI/read models.
- Client display components such as `DealStageBadge`, `PipelineProgress`, deal list chips, filters, and detail pages can still resolve or normalize inactive legacy stages for existing deals.

Client stage selection surfaces:

- New deal initial stage selector in `client/src/components/deals/deal-form.tsx` uses `getNewDealStages()` from `client/src/components/deals/deal-form.helpers.ts`, which already filters to `isActivePipeline`, `standard_deal`, non-terminal, canonical selectable slugs.
- Deal detail stage-change selector is `PipelineProgress` in `client/src/pages/deals/deal-detail-page.tsx`. The page builds `dealStages` by filtering `stage.isActivePipeline !== false` plus canonical selectable slugs before rendering clickable transition targets.

## Implementation

Server-side guard:

- Added `server/src/modules/deals/stage-write-guard.ts` with typed validation error code `INACTIVE_DEAL_STAGE` and message `Cannot set deal stage to inactive pipeline stage.`
- `createDeal()` now resolves the target stage and rejects inactive target stages before insert for normal direct-create and lead-conversion request paths.
- Migration-origin creation (`migrationMode` or `creationContext: "migration"`) is explicitly exempt so migration/import correction paths can preserve historical inactive stage assignments when needed.
- `validateStageGate()` rejects inactive target stages during preflight after preserving same-stage no-op behavior. Existing deals already on inactive stages can move to active stages.
- `changeDealStage()` also asserts the target stage from `validateStageGate()` before writing `deals.stage_id`, so the write path remains protected even if callers bypass preflight.
- No new parallel query fan-out was introduced on the request-scoped tenant DB transaction path.

Client-side guard:

- Deal creation and detail-page stage selectors already used active/canonical stage filters; these were left intact so inactive stages remain readable but not selectable.
- `PipelineBoard` now refuses inactive deal-stage drop targets and disables inactive deal columns as droppable areas.
- Legacy `/pipeline` page drag/drop now uses `resolvePipelinePageMove()` and disables inactive DD columns, preventing the stage-change dialog from opening for inactive target stages while still allowing a deal currently on an inactive stage to move to an active stage.
- Client preflight types now require `isActivePipeline` on current/target stage payloads.

## Tests

- `npm run build --workspace=shared` passed.
- Focused verification passed:
  - `TMPDIR=/private/tmp npx vitest run server/tests/modules/deals/service.test.ts server/tests/modules/deals/stage-change.test.ts server/tests/modules/deals/stage-gate.test.ts client/src/components/pipeline/pipeline-board.test.tsx client/src/pages/pipeline/pipeline-page.test.ts --testTimeout=15000 --exclude '.worktrees/**'`
  - Result: 5 files passed, 176 tests passed.
- Required broad command was run:
  - `TMPDIR=/private/tmp npx vitest run server/tests/ client/src/ shared/ --testTimeout=15000 --exclude '.worktrees/**'`
  - Result: failed with 51 failed files, 475 passed files, 331 failed tests, 3669 passed tests, and 251 errors.
  - The failures are in the pre-existing/unrelated categories called out for this repo, including sandbox/auth `listen EPERM`, `deal-list-page.test.tsx`, `detail-page-shell.test.tsx`, `detail-page` visual/KPI assertions, lead form, kanban card value formatting, and other non-stage-guard suites. The stage-guard focused files passed.

Coverage added:

- Active stage write succeeds through normal direct deal creation.
- Inactive stage write is rejected with typed `INACTIVE_DEAL_STAGE` error on create and stage change.
- Migration-origin create can preserve an inactive historical stage.
- A deal already on an inactive stage still reads through `getDealById()`.
- Stage preflight rejects inactive target stages while preserving active transition behavior.
- Deal board and legacy pipeline drag/drop do not offer inactive target columns for deal stage writes.

## Review rounds

- Round 1 found that the initial create guard blocked migration-origin preservation and that inactive DD columns were still reachable through deal board drag/drop. Fixes: exempted only migration-origin create paths, added migration preservation test, and disabled/refused inactive deal targets in `PipelineBoard`.
- Round 2 found that preflight client types should require `isActivePipeline` and the guard should fail closed if stage metadata is missing the active flag. Fixes: made preflight payload types explicit and changed the helper to reject unless `isActivePipeline === true`; updated stage-gate tests to model real active rows.
- Round 3 found the legacy `/pipeline` board still accepted inactive DD drag targets when DD columns were shown. Fix: added `resolvePipelinePageMove()`, disabled inactive legacy board drop zones, wired drag-end through the resolver, and added a regression test. Follow-up review found no remaining logic blockers after this fix; the only procedural note was to include the new guard helper file in the commit.
