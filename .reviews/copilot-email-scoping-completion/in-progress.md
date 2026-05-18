## Scope

- P0 hotfix for remaining copilot email user-scoping gaps from PR #375.
- Target branch: `hotfix/copilot-email-scoping-completion`
- Constraints: no production smoke, manual merge only, do not touch `server/src/modules/deals/service.ts`.

## Active Work

- Trace forced copilot regeneration path and thread `viewerUserId`/`requestedBy`.
- Expand deal-email predicates to include both direct `deal_id` and assigned-entity deal linkage.
- Add regression tests for copilot context, guard, and worker propagation.
