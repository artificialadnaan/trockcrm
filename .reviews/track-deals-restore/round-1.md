## Findings

### P1 - Required decorated card component is untracked

`client/src/pages/deals/deal-list-page.tsx:23` imports `@/components/deals/decorated-kanban-card`, but `client/src/components/deals/decorated-kanban-card.tsx` is currently untracked (`git ls-files --others --exclude-standard`). The worktree tests pass because the file exists locally, but a commit/PR made from only the tracked diff would fail module resolution and break `/deals`. Add the new component file to the change before handoff.

### P2 - Unassigned deals show company initials in the owner avatar

`client/src/components/deals/decorated-kanban-card.tsx:7-9` derives avatar initials from `deal.assignedRepName || deal.companyName || "TR"`, and `client/src/components/deals/decorated-kanban-card.tsx:70-74` renders those initials as the red owner avatar next to the account line. The locked spec calls for owner avatar initials; the baseline fallback was `"TR"` when there was no assigned rep. With the current fallback, an unassigned `Acme Construction` deal renders `AC` in the owner avatar, which mislabels account initials as owner initials.

## Commands Run

- `wc -l /tmp/deals-revert-discovery.md /tmp/preview-deals-discovery.md /tmp/deals-baseline.tsx`
- `sed -n '1,260p' /tmp/deals-revert-discovery.md`
- `sed -n '261,520p' /tmp/deals-revert-discovery.md`
- `sed -n '1,260p' /tmp/preview-deals-discovery.md`
- `sed -n '261,520p' /tmp/preview-deals-discovery.md`
- `sed -n '1,260p' /tmp/deals-baseline.tsx`
- `sed -n '261,520p' /tmp/deals-baseline.tsx`
- `git status --short --branch`
- `git diff --stat`
- `git diff --name-only`
- `git log --oneline -5`
- `git diff -- client/src/pages/deals/deal-list-page.tsx`
- `git diff -- client/src/components/deals/deals-list-section.tsx`
- `sed -n '1,260p' client/src/components/deals/decorated-kanban-card.tsx`
- `git diff -- client/src/pages/deals/deal-list-page.test.tsx client/src/components/deals/deals-list-section.test.tsx`
- `nl -ba client/src/pages/deals/deal-list-page.tsx | sed -n '1,460p'`
- `nl -ba client/src/components/deals/decorated-kanban-card.tsx | sed -n '1,220p'`
- `nl -ba client/src/components/deals/deals-list-section.tsx | sed -n '260,700p'`
- `nl -ba client/src/components/deals/kanban-deal-card.tsx | sed -n '1,180p'`
- `nl -ba client/src/components/deals/kanban-scroll-column.tsx | sed -n '1,220p'`
- `rg -n "Board|Map|Coverage map|DFW map|TerminalDateFilter|Won date|Lost date|DEAL_BOARD_STAGE_SLUGS|workflowFamily|enableDateFilter|DealsListSection|usePipelineStages\\(|useDealBoard\\(" client/src/pages/deals client/src/components/deals client/src/App.tsx server shared`
- `nl -ba client/src/lib/canonical-deal-board.ts | sed -n '1,220p'`
- `rg -n "function getDealBoardStageSlugs|const .*DEAL.*STAGE|contract|lost|won" client/src/lib/pipeline-ownership.ts shared/src/types/workflow.ts`
- `nl -ba client/src/lib/pipeline-ownership.ts | sed -n '36,176p'`
- `npx vitest run client/src/pages/deals/deal-list-page.test.tsx client/src/components/deals/deals-list-section.test.tsx`
- `git diff --cached --stat`
- `git ls-files --others --exclude-standard`
- `git diff -- client/src/App.tsx client/src/pages/pipeline/pipeline-page.tsx server shared`
- `git diff --check`
