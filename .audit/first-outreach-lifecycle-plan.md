# Fix `daily_first_outreach_touchpoint` task lifecycle — plan

**Branch:** `fix/first-outreach-task-lifecycle` (worktree `.wt-outreach`, base origin/main @ 83575139)

## Phase 0 (done)
- Rule is **contact-based**: worker `daily-tasks.ts:228` mints a `touchpoint` task per contact with `is_active=true AND first_outreach_completed=false AND created_at < now-3d` and no open touchpoint task. dedupe key `contact:{id}:daily_first_outreach_touchpoint`.
- Completion signal already exists: a PG `touchpoint_trigger` sets `contacts.first_outreach_completed=true` on any call/email/meeting activity (`activities/service.ts:196-199`); `task-completed.ts:142` does the same on task completion.
- **Gap:** nothing dismisses the open task when the flag flips via a logged activity → lingers overdue forever. And `suppressionWindowDays:0` + dismiss writing `suppressed_until:NULL` means a plain dismiss gives ZERO suppression (`evaluator.ts:43-45`) → re-mints. Stale-lead avoids this only because its create query stops selecting resolved leads.

## Decision (Adnaan): expire at **30 days**.

## Design (Option C — resolution dismiss + 30-day window, complementary axes)
The first-outreach window is contacts **3–30 days old**. Resolution and expiry are complements on the SAME axis (`contacts.created_at`), so a dismissed task can never re-mint.

1. **Bound the create window** (`daily-tasks.ts` `needsOutreach` query): add `AND c.created_at >= CURRENT_DATE - INTERVAL '30 days'`. Only mint for 3–30-day-old contacts; older uncontacted contacts stop getting new first-outreach tasks (cadence rule governs ongoing contact).
2. **`dismissResolvedFirstOutreachTasks(client, schema, officeId, resolvedAt, windowDays=30)`** (new, mirrors `dismissResolvedStaleLeadTasks`): `UPDATE … SET status='dismissed', completed_at, is_overdue=false, waiting_on=NULL, blocked_by=NULL, updated_at=NOW()` for open `daily_first_outreach_touchpoint` tasks WHERE **either**:
   - **resolved**: `NOT EXISTS (contact c: c.id=t.contact_id AND c.is_active AND NOT c.first_outreach_completed)` — covers outreach-completed (flag=true), inactive, deleted; OR
   - **expired**: `EXISTS (contact c: c.id=t.contact_id AND c.created_at < now-30d)` — aged out of the window.
   RETURNING a per-row `resolution_reason` = `first_outreach_resolved | first_outreach_expired`; then upsert `task_resolution_state` per row (mirror stale-lead, `suppressed_until=NULL`). Re-mint is prevented structurally (resolved→create filters flag=false; expired→create filters created_at≥now-30d), NOT by suppression.
   Call it in `runDailyTaskGeneration` inside the per-office txn, **before** the `needsOutreach` create block (mirrors stale-lead order).
3. **One-time cleanup script** `worker/src/scripts/dismiss-stale-first-outreach.ts` (dry-run default): loops active offices, per office `BEGIN → dismissResolvedFirstOutreachTasks → ROLLBACK (dry-run) | COMMIT (--apply)`, prints counts. Reuses the function (no predicate drift; dry-run via rollback). NOTE: the daily job already auto-clears the backlog on its next run; this just lets ops do it now with a preview.

## Tests (runtime)
- `worker/tests/jobs/first-outreach-dismiss.runtime.test.ts` (PGlite real SQL, mirrors `email-sent-sync.runtime.test.ts`): dismisses outreach-completed / inactive / expired (>30d) tasks; does NOT dismiss a still-needed (active, flag=false, recent) task; records `task_resolution_state` reason correctly; returns the right count; a dismissed-then-re-evaluated contact does not re-qualify (create predicate check).
- Extend `worker/tests/jobs/daily-tasks.test.ts` (mock) to assert the `needsOutreach` SQL now carries the 30-day upper bound, and that `dismissResolvedFirstOutreachTasks` is invoked before the create loop.

## Gate note
`check:premerge` runs worker **build + typecheck:tests** (so worker src/tests are type-checked in CI) but worker has no `test:ci`, so worker tests don't EXECUTE in the gate. Tests run locally + reviewed by bots. Not widening the gate here (scope).

## No migration, no server change (config.ts untouched — suppression not relied upon).
