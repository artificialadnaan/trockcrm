# Track Final Cleanup Review - Round 1

## P1 Findings

- `server/src/modules/deals/service.ts:1592-1605` still excludes the real legacy terminal aliases from canonical Won/Lost queries because `wonStageIds` and `lostStageIds` require `stage.isActivePipeline`. The final-cleanup requirement says canonical terminal columns must query canonical plus legacy aliases (`sent_to_production`, `closed_won`, `service_sent_to_production`; `production_lost`, `closed_lost`, `service_lost`) when canonical Won/Lost exists. The production seed explicitly keeps those legacy rows as inactive historical aliases so existing closed/lost deals retain their original `stage_id` (`migrations/0064_bidboard_stage_v2_seed.sql:7-8`, `:37-60`). With the current filter, canonical Won/Lost columns only include aliases if the alias rows are active, so historical alias-stage deals remain undercounted in `/pipeline` and `/deals` terminal totals. The added tests do not catch this because the canonical-alias fixtures set the aliases to `isActivePipeline: true` (`server/tests/modules/deals/pipeline-team-scope.test.ts:349-356`, `:455-460`), which is the opposite of the real historical-alias state. Remove the active-stage predicate from the alias ID sets used when canonical Won/Lost exists, while preserving the existing response-stage filtering so inactive aliases do not render as separate columns.

## P2 Findings

- `client/src/components/deals/deals-list-section.tsx:117-129` enables a selected-stage list query during stage metadata loading/error whenever the selected IDs are not present in `terminalStageIds`. But `terminalStageIds` is derived from `stages` at `client/src/components/deals/deals-list-section.tsx:290-295`; on metadata error that array is empty, while `/pipeline` can still render chips from `visibleStages`. Selecting a terminal chip such as Won/Lost in that state is misclassified as non-terminal, so the list sends `isActive=true` instead of staying disabled or using pipeline terminal visibility. That silently hides inactive terminal records instead of showing the metadata error. The bypass should only apply to selections known to be non-terminal, for example by carrying `isTerminal` through `visibleStages`/stage options or by refusing to enable selected stages whose terminal status is unknown.

## Verified Areas

- `/deals` now mounts `DealListPage` directly and `/pipeline` still mounts `PipelinePage`.
- `/deals/:id` remains routed to `DealDetailPage`.
- `/deals` renders the board surface directly, keeps the embedded `DealsListSection` out, filters the board to the requested five canonical active columns, and reruns the top-scrollbar sizing effect after loading changes.
- `/pipeline` still renders the full board plus the embedded `DealsListSection`, date filters, and shared card/scroll-column components.
- `DealsListSection` now requests `usePipelineStages("deal")`, groups same-slug chip IDs, resets page on `scope` prop changes, and applies the DD chip exclusion prop.

## Verification Notes

- I reviewed the current uncommitted diff and the supplied `.reviews/track-final-cleanup/discovery.md`.
- I did not rerun the already reported test commands.
