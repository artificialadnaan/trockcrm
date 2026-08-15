# Handoff — Estimator pipeline filter (deals dashboard)

> ## ⚠️ HISTORICAL — do not follow §4 as a task list
>
> This was a mid-work handoff written at commit `bc963c5b7`, when the server was complete and the client
> was half-wired. **It is kept for the decisions and the production measurements in §1–§3, not as
> instructions.**
>
> Superseded by **PR #1067**. Everything §4 lists as outstanding is done: the stale board-hook assertions,
> the Admin → Users "Estimates Jobs" checkbox, the server and client tests, and the mutation passes. The
> filter also gained work this document never anticipated, across four rounds of bot review — the list and
> CSV serialization, drill-down propagation into the stage page, the Won-YTD snapshot guard, a uuid guard
> against 22P02, and owner/estimator precedence for URLs carrying both.
>
> §4.5 (the `generates_sales` untick) is the one item still OPEN, and it carries an unresolved question:
> decision 3 unticks Kason Reeder, but the verified roster in §3 lists him under Sales, which requires that
> flag true. With `estimates_jobs` false he would appear in neither section. That needs a human call.

**Branch:** `feat/estimator-pipeline-filter` · **WIP commit at time of writing:** `bc963c5b7` · **Base:** `main` @ `8186c374c`
**Worktree:** `/Users/adnaaniqbal/Developer/trockcrm/.claude/worktrees/estimator-filter` (deps installed, `shared` built)

---

## 1. The problem

On the Deals Dashboard, picking a person in the Rep dropdown returns **their owned deals**. That is
deliberate — `buildOwnedRepCondition` in `server/src/modules/deals/deal-filter-predicates.ts` documents at
length why a rep filter must not also match the estimator link (it would put one deal on two people's rows
and break reconciliation with every by-owner surface).

The consequence nobody had addressed: **an estimator who owns nothing is unreachable.** Measured in
production 2026-08-14:

| Person | Owns | Estimating (total) | Self-estimated | **Estimating for others** |
|---|---|---|---|---|
| Sidney Gibson | **0** | 137 | 0 | **137** |
| Timothy Mitchell | 265 | 142 | 45 | **97** |
| Alex Koch | **0** | 72 | 0 | **72** |
| Colby Burling | 367 | 221 | 167 | **54** |
| Brett Bell | 2 | 21 | 0 | **21** |
| James Helms | 3 | 12 | 2 | **10** |
| Andrew Green | 146 | 119 | 112 | **7** |
| Caleb Stone | 23 | 22 | 21 | **1** |

Selecting Sidney showed an empty board. Adnaan's words: *"if i filter sidney i want to see all the projects
she is estimating on."*

**Do not "fix" this by loosening the rep filter to owner-OR-estimator.** That was considered and rejected;
`deals.estimator_user_id` is dominated by reps estimating their OWN deals (167 of Colby's 221), so an
OR filter would show a rep dozens of deals that are someone else's book.

---

## 2. Decisions Adnaan made (do not re-litigate)

Asked and answered explicitly, the third one after being shown the corrected numbers above:

1. **Classification = a new explicit checkbox**, `users.estimates_jobs`, in Admin → Users — *not* derived
   from the data. He wants to decide who counts.
2. **One person appears in exactly ONE section.** When both flags are ticked, **Sales wins**. He was shown
   that this makes Timothy's 97 and Colby's 54 estimated-for-others deals unreachable through this control,
   and chose it anyway for a shorter list.
3. **Untick `generates_sales` on Sidney Gibson, Alex Koch and Kason Reeder** once the Estimators section
   exists — they were ticked purely to appear in the filter, which also lists them on the director
   dashboard as reps with zero sales. **Claude prepares a dry-run; Adnaan runs the write.**

---

## 3. What is DONE (all committed in `bc963c5b7`)

### Server — complete, `npm run typecheck` clean

- **`migrations/0222_users_estimates_jobs.sql`** — adds `public.users.estimates_jobs boolean NOT NULL
  DEFAULT false`. Deliberately **no classification pass** (unlike 0219): `users` is global while `deals` is
  per-tenant, so seeding from `office_*.deals` would set a global flag from one office's data. Guard is
  keyed on the column's existence so a replay cannot reset admin decisions. Migration number verified free
  across all remote heads.
- **`shared/src/schema/public/users.ts`** — `estimatesJobs` column.
- **`server/src/modules/admin/users-service.ts`** — `estimatesJobs` threaded through the two list queries,
  the drizzle select, the row mappers, `CreateCrmUserInput`, the create insert (defaults false), and the
  update path with a boolean-type check. New `assertEstimatesJobsAllowedForRole` (field contractors
  rejected), mirroring the generates_sales guard.
- **`server/src/modules/dashboard/service.ts`** — `getRepRosterOptions` now returns
  `{ id, displayName, group: "sales" | "estimator" }` from a `UNION ALL`. Sales leg unchanged. Estimator leg
  = `estimates_jobs = true AND generates_sales = false AND (office membership OR estimates a deal in this
  tenant)`. **The Sales-wins rule is enforced in SQL**, not in JS, so no caller can reassemble a double
  listing.
  > ⚠️ **Landmine already hit and fixed:** Postgres rejects `ORDER BY lower(x)` directly on a `UNION`
  > ("Only result column names can be used, not expressions or functions"). The UNION is wrapped in a
  > subquery. Neither `tsc` nor the mocked-execute unit tests catch this — it was found by running the SQL
  > against production. **Run new SQL against a real database.**
- **`server/src/modules/deals/deal-filter-predicates.ts`** — `buildEstimatorCondition` (bare
  `eq(deals.estimatorUserId, id)`, no Unassigned sentinel, and the comment explains why) +
  `buildEstimatorPredicate` + registry entry + param-contract doc line.
- **`server/src/modules/deals/service.ts`** — `DealFilters.estimatorId`; `getDealsForPipeline` accepts
  `estimatorId` and ANDs `buildEstimatorCondition` into `commonConditions` (after scope, so Mine/Team still
  applies).
- **`server/src/modules/deals/routes.ts`** — `GET /deals` and `GET /deals/pipeline` read `?estimatorId`.

**Verified against production** (read-only) that the grouped roster returns exactly:
Sales (11): Andrew Green, Caleb Stone, Chase Kelly, Chris Higingbotham, Colby Burling, Daniel Chac,
Derek Barr, Edward McCarty, Kaleb Marshall, Kason Reeder, Timothy Mitchell.
Estimators (2): Alex Koch, Sidney Gibson. *(simulated with the intended flag values, no writes)*

### Client — compiles (`npm run typecheck` clean), tests not yet updated

- **`client/src/hooks/use-rep-roster.ts`** — `RepRosterGroup` type; `group` defaulted to `"sales"` when
  absent so an older/cached response cannot drop people out of both sections.
- **`client/src/lib/rep-filter-options.ts`** — `RepFilterOption.group?`, optional because an appended
  off-roster selection has no group.
- **`client/src/pages/deals/deal-list-page.tsx`** — the main change:
  - `selectedEstimatorFilter` reads `?estimatorId`; `selectedRosterValue` prefixes estimator ids with
    `est:` so the dropdown value states which question was asked.
  - `updateSelectedRep` routes to `?assignedRepId` or `?estimatorId` and **always clears the sibling**
    (they are mutually exclusive; leaving both would AND them server-side).
  - `salesRepOptions` / `estimatorOptions` partition; grouped `SelectGroup`/`SelectLabel` rendering that
    **falls back to the old flat list when no estimators are ticked**.
  - Trigger label reads `"Sidney Gibson (estimating)"`.
  - `estimatorId` carried into the board query (`useDealBoard`) and both list-filter sites.
- **`client/src/hooks/use-deals.ts`** — `useDealBoard` gained a 7th arg `estimatorId` (after
  `estimateSentDateRange`) and sends `?estimatorId`.
- **`client/src/lib/deals-view-preferences.ts`** — `estimatorId` added to the persistable allowlist.
- **`client/src/pages/leads/lead-list-page.tsx`** and **`client/src/components/deals/deals-list-section.tsx`**
  — filtered to **sales-only**. Both write an OWNER filter, so offering an estimator there would recreate
  the exact "pick a name, get nothing" bug. Leads have no estimator column at all.

---

## 4. What is LEFT — in order

### 4.1 Fix the 13 failing tests (mechanical, start here)
`cd client && npx vitest run src/pages/deals/deal-list-page`

All failures are stale **call-arity** assertions on the `useDealBoard` spy, which now takes two more
positional args. Two shapes already fixed; the remainder use `expect.any(Object)` / multi-line forms:

```
expect(mocks.useDealBoardMock).toHaveBeenCalledWith("mine", true, expect.any(Object), 1000, null, undefined)
                                                    → append , undefined, undefined
```
Also `client/src/hooks/use-rep-roster.test.ts` — expectations need `group: "sales"` on each rep object.

### 4.2 Admin UI checkbox (not started)
`client/src/pages/admin/users-page.tsx`. Mirror the "Generates Sales" column exactly — it is at
`TableHead` ~line 649 with the subtitle *"Shows on rep performance views"*, and the toggle handler is
`handleToggleGeneratesSales` (~line 178). Suggested label: **"Estimates Jobs"** / *"Shows in the Estimators
filter"*. The `updateUser` API already accepts `estimatesJobs`. Also add it to the client's user type.

### 4.3 Tests to write
- `server/tests/modules/dashboard/rep-roster-options.test.ts` — extend: estimator leg present, Sales-wins
  exclusion (`generates_sales = false` in the estimator arm), grouped mapping, ORDER BY inside the subquery.
- `server/tests/modules/deals/` — `buildEstimatorPredicate` unset→undefined, set→eq on `estimator_user_id`,
  and that it does **not** consult `assigned_rep_id`.
- Client — grouped rendering; `est:` value writes `?estimatorId` and clears `?assignedRepId`; leads/section
  exclude estimators.
- **Mutation-test every guard** (house standard): revert the guard, confirm the test fails, restore with
  `cp file /tmp/x.bak` — never `git checkout --`.

### 4.4 Full verification
```
cd server && npm run typecheck && TZ=UTC npm run test:ci     # 819 files / ~8177 tests on main
cd client && npm run typecheck && npx vitest run             # ~3040 tests; 20 e2e FILES always fail (Playwright, pre-existing)
```

### 4.5 Prod dry-run for Adnaan (do NOT execute)
After merge, prepare the `generates_sales` untick for Sidney Gibson, Alex Koch, Kason Reeder and give him
the command. **He runs all prod writes.** Read-only census is fine and expected.

### 4.6 PR
`gh pr create --base main`, then comment `@codex review` and `@coderabbitai review`.

---

## 5. Session rules that will bite you

- **Never use the shelf command** (`git st‑ash`). Hook-enforced — it even rejects the phrase inside a commit
  message. Commit WIP to your own branch instead.
- **`git add` by explicit path**, never `-A` at the repo root.
- **Claude never merges.** Drive to clean and stop. (Adnaan gave a one-off exception for #1066; it does not
  carry forward.)
- **All prod writes are Adnaan's.** Dry-run and census freely; never `--execute`.
- **No prettier / no format passes** — there is no config and it buries the diff.
- **Codex signals CLEAN with a 👍 REACTION on the PR**, not a comment or review:
  `gh api repos/artificialadnaan/trockcrm/issues/<pr>/reactions`. A poller watching only reviews/comments
  will wait forever — this cost ~75 minutes on #1066.
- **The `10px` design-hook findings in `deal-list-page.tsx`, `deals-list-section.tsx` and
  `lead-list-page.tsx` are pre-existing false positives.** All blame to commit `b4f8d0d07`; this branch adds
  zero `10px`. Verify with `git diff origin/main...HEAD | grep '^+' | grep -c '10px'` → 0. Do not add ignores.
- `cd server && npx vitest run` **skips ~35 files**; only `npm run test:ci` matches the CI gate.
- A fresh worktree needs `npm install` **and** `cd shared && npm run build`, or the server typecheck lies.
- Clean up stale worktrees after the feature (`git worktree list`; judge staleness by PR state, not
  `--merged` — this repo squash-merges so ancestry is lost; never remove a dirty tree).

## 6. Useful context

- Prod DB read-only: `railway variables --service Postgres --environment production --kv` →
  `DATABASE_PUBLIC_URL`. Never print it.
- Dallas office id: `802f4260-983b-4f4a-b538-9cc2c7740703`. All 1,383 active deals live in `office_dallas`;
  `office_atlanta` and `office_pwauditoffice` are empty. `DFW-`/`ATL-` in a project number is the REGION,
  not the tenant.
- Related merged work: **#1066** (this filter's predecessor — roster + name casing) and its 17 bot findings
  across 7 rounds. Read `getRepRosterOptions`' doc comment before changing the roster.
