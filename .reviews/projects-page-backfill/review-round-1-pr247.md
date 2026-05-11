# PR #247 Review — Round 1

Reviewer: `oh-my-claudecode:code-reviewer`.

## Verdict

REQUEST CHANGES → fixed in this branch before merge.

## P0

None.

## P1 — fixed in this branch

1. **`backfill-service.ts:155` — session-level `SET search_path` could leak to next pool consumer.** node-postgres does NOT call `DISCARD ALL` on `client.release()`, so the next request that picks up this client would inherit `search_path = office_dallas, public` instead of the default. Could route unrelated queries to the wrong office's tables.
   - Fix: `RESET search_path` in the `finally` block before `client.release()`. Plus a regression test asserting RESET runs and precedes release in invocation order.

## P2 — fixed in this branch

1. **`backfill-service.ts:125` — silent `.catch(() => {})` on per-row ROLLBACK** swallowed connection-level errors.
   - Fix: log via `console.error` with `procoreProjectId` and the rollback error.

## P2 — accepted, deferred

1. No advisory lock / mutex on `/api/projects/backfill`. Two simultaneous admin invocations would each acquire a connection and double the Procore API load. Upserts are idempotent so no data corruption, just waste. Acceptable for a manually-invoked admin endpoint.

## Cleared on review

- `app.current_user_id` GUC: no audit triggers exist on `projects`, `project_phase_history`, `project_sync_state`. Latent risk if added later, not a bug today.
- Double-commit risk: `tenantMiddleware`'s `commitTransaction` is idempotency-guarded by a `committed` boolean, so the route's pre-backfill `commitTransaction` plus a thrown error from the backfill cannot double-commit.
- SQL injection on `schemaName`: `quoteIdent()` uses regex allowlist `^[a-zA-Z_][a-zA-Z0-9_]*$`. Input originates from DB-stored office slugs.

## Final state after fix

- 5/5 backfill tests pass (including new RESET-before-release test).
- 23/23 scoped tests pass.
- typecheck exit 0.
