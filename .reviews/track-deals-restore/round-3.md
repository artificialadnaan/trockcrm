## Findings

No P1/P2 findings.

## Verification Notes

- `git status --short` shows `client/src/components/deals/decorated-kanban-card.tsx` staged as an added file.
- `git diff --cached --name-only` includes `client/src/components/deals/decorated-kanban-card.tsx`, so the PR cannot omit the `/deals` import target if committed from the staged index.
- No `/pipeline`, backend, server, shared, or route/config files are staged. Staged paths are limited to `.reviews/track-deals-restore/*`, `client/src/components/deals/*`, and `client/src/pages/deals/*`.
- Owner avatar initials in `DecoratedKanbanCard` derive from `deal.assignedRepName` only and fall back to `TR` when no assigned rep is present; `companyName` remains only the account-line display fallback path.
- The staged patch preserves the locked `/deals` scope: eight canonical columns, decorated cards, scoped exportable list below the board with date filters disabled, and no preview-only map/date-filter UI.
