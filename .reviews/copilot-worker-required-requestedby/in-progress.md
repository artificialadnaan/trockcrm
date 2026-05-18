## Scope

- Post-merge hotfix for PR `#376`
- Enforce required `requestedBy` at the worker boundary for copilot refresh/generate jobs
- Keep `server/src/modules/deals/service.ts` untouched

## Active Work

- Add non-retryable worker boundary rejection for missing `requestedBy`
- Audit all `ai_refresh_copilot` and `ai_generate_deal_copilot` enqueue paths
- Add regression coverage for worker rejection/pass-through behavior and current enqueuers
