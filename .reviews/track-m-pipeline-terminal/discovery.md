# Track M Pipeline Terminal Stage Scoping Discovery

Date: 2026-05-10
Branch: fix/pipeline-terminal-stage-scoping
Starting SHA: f1771f6 (PR #219 merge)

## Starting State

- `git log -10` includes `f1771f6 Merge pull request #219 from artificialadnaan/fix/deals-pipeline-consistency`.
- Isolated worktree: `/Users/adnaaniqbal/projects/trockcrm-pipeline-terminal-fix`.

## Client Pipeline List Flow

- `PipelinePage` loads the kanban board from `/deals/pipeline` into `columns` and `terminalStages`.
- `stageFilterOptions` is built from rendered `columns`, deduped by stage slug, then used as the visible stage filter set.
- `selectedStageIds` maps selected filter slugs back through `stageFilterOptions`, so explicit stage selections already use visible board stages.
- `terminalStageIds` currently comes from `usePipelineStages()` and includes every `stage.isTerminal` from `/pipeline/stages`.
- `listIsActiveFilter` returns `"pipeline"` for no selection or any selected terminal stage; otherwise it returns active-only `true`.
- `listInactiveStageIds` sends all `terminalStageIds` when no list stage is selected, and only selected terminal IDs when there is a terminal selection.
- `useDeals` sends these params to `/deals`; `exportListCsv` uses the same filter state through `fetchAllFilteredDeals`.

## Pipeline Stage Hook

- `PipelineStage` fields include `id`, `name`, `slug`, `workflowFamily`, `displayOrder`, `isActivePipeline`, `isTerminal`, requirements, stale threshold, Procore mapping, and color.
- There is no separate `isVisible` field in the hook response type.
- The hook caches `/pipeline/stages` independently of the board payload.
- On fetch failure, `usePipelineStages` logs the error, sets `loading=false`, and returns the default empty `stages` array. It does not expose an error state.
- This means `terminalStageIds=[]` is indistinguishable from a tenant with no terminal stages.

## Server Pipeline Board Flow

- `getDealsForPipeline` loads all standard/service deal stages from `pipeline_stage_config`.
- Terminal outcome aliases:
  - Won: `won`, `sent_to_production`, `service_sent_to_production`, `closed_won`.
  - Lost: `lost`, `production_lost`, `service_lost`, `closed_lost`.
- `canonicalWonStageId` is the active `won` stage, if present.
- `canonicalLostStageId` is the active `lost` stage, if present.
- `responseStages` excludes inactive terminal stages and, when a canonical won/lost stage exists, keeps only that canonical terminal column.
- Current per-stage query behavior still uses `inArray(deals.stageId, wonStageIds)` or `inArray(deals.stageId, lostStageIds)` for every terminal alias column.

## Confirmed Bugs

- P1 #1: With no list stage selected, `listInactiveStageIds` can include hidden or inactive terminal configs from `/pipeline/stages`, not just terminal columns currently visible in the board.
- P2 #1: If the independent stage config hook is loading or fails, the list can compute the wrong active-state filter from an empty terminal ID set while the board itself still renders.
- P2 #2: If there is no canonical `won`/`lost` stage and multiple active terminal aliases render, each alias column queries the full outcome alias union and can duplicate cards/counts.

## Fix Plan

- Derive list terminal IDs from the visible board-stage subset (`stageFilterOptions`) intersected with the loaded stage metadata. This keeps list/export terminal scoping aligned with rendered columns.
- Expose `error` from `usePipelineStages` and make the pipeline list query explicitly wait for successful stage metadata before requesting list/export data.
- In `getDealsForPipeline`, keep canonical behavior when canonical terminal stages exist, but when no canonical stage exists, query each terminal alias column by its own `stage.id`.
