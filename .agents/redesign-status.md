# Redesign Status

> Living coordination doc. Each agent: read before claiming, write a line when claiming or releasing. Use 24h-clock UTC timestamps.
>
> **Format:** `YYYY-MM-DDTHH:MMZ [agent-label] STATUS — short description (PR #__ if open)`
>
> **STATUS values:** `CLAIM` / `WIP` / `BLOCKED` / `PR-OPEN` / `MERGED` / `ABANDONED`
>
> **Rules:**
> - Append-only. Never edit another agent's line.
> - One line per sub-PR (a track can have multiple sub-PRs in flight).
> - Releasing a claim without finishing → write an `ABANDONED` line with reason. Don't silently disappear.
> - Stale claims (>24h with no follow-up) may be reclaimed after the human confirms.
> - Human is the final referee.

## Track 0 — Coordination
- 2026-05-07T17:30Z [main-agent] PR-OPEN — initial plan revision + status doc + gap audit (PR #150)

## Track A-core — Schema + Hooks (sequential A1 → A2 → A3)
- 2026-05-07T18:34Z [track-a-core-agent] CLAIM — A1 in flight (branch: redesign/schema-hooks-core/a1)
- 2026-05-07T19:00Z [track-a-core-agent] PR-OPEN — A1 (PR #155)
- A2 CLAIM 2026-05-07T22:21Z: redesign/schema-hooks-core/a2, Tier 2 deals/leads/emails/files schema + junctions + secondary contact on deal + office on leads. ETA TBD. Worktree: trockcrm-redesign-data.
- 2026-05-07T22:41Z [track-a-core-agent] PR-OPEN — A2 Tier 2 schema ready for review (PR #161)

## Track A-isolated — Reports + Snapshots (A4 + A5a parallel; A5b after A1)
- 2026-05-07T19:16Z [track-a-isolated-agent] CLAIM — A4 in flight (branch: redesign/schema-hooks-isolated/a4)
- 2026-05-07T19:29Z [track-a-isolated-agent] PR-OPEN — A4 (PR #156)
- 2026-05-07T19:31Z [track-a-isolated-agent] CLAIM — A5a in flight (branch: redesign/schema-hooks-isolated/a5a)
- 2026-05-07T20:27Z [track-a-isolated-agent] PR-OPEN — A5a (PR #158)
- A5b CLAIM 2026-05-07T22:21:35Z: redesign/schema-hooks-isolated/a5b, stale_account_count on rep_performance_snapshots. ETA TBD. Worktree: trockcrm-redesign-data-isolated.
- A5b SCOPE-EXPAND 2026-05-07T22:25:33Z: folded PR #158 Codex catches (historical pipeline filter + inserted counter scoping) into A5b PR.
- A5b PR-OPEN 2026-05-07T22:36:17Z: PR #160 opened for stale_account_count and folded PR #158 Codex catches.
- A5b CODEX-FIX 2026-05-07T23:10:43Z: PR #160 force-pushed with stale-account period-scoping fix on both branches + regression test.
- A5b CODEX-FIX-4 2026-05-08T05:51:46Z: PR #160 force-pushed with three fixes (P1 historical deals_count determinism, P2 cross-period semantics docs, P2 stale_accounts is_active removal). Two regression tests added. PRODUCT.md updated with metric determinism design doc.
- A5b CODEX-FIX-5 2026-05-08T14:09:45Z: PR #160 force-pushed with three fixes (P1 historical pipeline_value determinism, P2 stale cutoff end-of-day, P3 doc alignment). Two regression tests added.
- A5b CODEX-FIX-6 2026-05-08T15:11:13Z: PR #160 force-pushed with PRODUCT.md doc update acknowledging stale_account_count structural limits. No code changes. Follow-up issue #168 filed tracking activity-history, ownership-history, and UTC anchor work.

## Track B — Shared Primitives + Shell + Harness
- _no claims yet_

## Track C — List Pages
- _no claims yet_
- C CLAIM 2026-05-07T22:21Z: redesign/list-pages, rep dashboard polish + companies/contacts/properties list. ETA TBD. Worktree: trockcrm-redesign-lists.
- 2026-05-07T22:43Z [track-c-agent] PR-OPEN — list pages: rep dashboard polish + companies/contacts/properties (PR #162)

## Track D — Workflow Pages
- _no claims yet_

## Track E — Detail Pages
- E PHASE-1 CLAIM 2026-05-08T16:25:49Z: redesign/detail-shell-phase1, shared shell + contact polish + reports placeholder + backend additions for E2-E5. ETA EOD 2026-05-08. Worktree: trockcrm-redesign-detail-shell.
- E PHASE-1 PR-OPEN 2026-05-08T16:28:51Z: PR https://github.com/artificialadnaan/trockcrm/pull/174. Foundation for parallel sub-tracks E2-E5.
- E PHASE-1 MERGED-DEPLOYED 2026-05-08T16:57:36Z: PR #174 merged to main, Railway deploy verified. Phase 2 sub-tracks (E2-E5) cleared to spawn.

## Track F — Specialty Pages
- _no claims yet_

## Track Z — Rollout
- _no claims yet_

## Cross-track risks (live)
- _no risks logged_
- A2 WIP 2026-05-07T22:37Z: migration number is `0104_redesign_a2_tier2_schema.sql` because A-isolated already consumed `0101`-`0103`; `file_links` shape is `(id, file_id, entity_type, entity_id, created_at, created_by)` with `UNIQUE(file_id, entity_type, entity_id)` and `INDEX(entity_type, entity_id)`.

## Track B — Shared Primitives + Shell + Harness
- 2026-05-07T18:34Z [track-b-agent] CLAIM — single PR in flight (branch: redesign/shared-primitives)
- 2026-05-07T18:49Z [track-b-agent] PR-OPEN — shared primitives + shell + harness ready for review (PR #154)
- D CLAIM 2026-05-07T22:21Z: redesign/workflow-pages, deals board + leads board + tasks page (PR 1), files page deferred to PR 2 post-A2. ETA TBD. Worktree: trockcrm-redesign-flow.
- D PR-OPEN-DRAFT 2026-05-07T23:01Z: PR https://github.com/artificialadnaan/trockcrm/pull/163, /deals + /leads + /tasks. DRAFT until deals-pipeline office filter hotfix merges. /files deferred to PR 2.
- D PR-READY 2026-05-07T23:06Z: PR #163 marked ready for review. Original "blocker" was a misread of intentional cross-office visibility on deals-pipeline; director-scoping bug is a separate main-targeting hotfix and does not gate Track D.
- D CODEX-FIX 2026-05-07T23:15Z: PR #163 force-pushed with two SPA-state regression fixes (leads bucket filter, terminal date filter staleness). Two regression tests added.
- A2 CODEX-FIX 2026-05-07T23:35Z: PR #161 force-pushed with two data-integrity fixes (estimate alias backfill rewrite, deal_contacts unique key + dedupe). Two regression tests added. Fresh DB apply against post-fix SHA verifies the new constraint shape.
- D CODEX-FIX-2 2026-05-07T23:39Z: PR #163 force-pushed with three additional Codex fixes (Won YTD window, lead listLeads scope full-stack, task row keyDown propagation). Track D scope expanded to include backend listLeads change. Three regression tests added (backend listLeads scope + two frontend).
- A2 CODEX-FIX-2 2026-05-08T03:17Z: PR #161 force-pushed with two more Codex fixes (Drizzle schema parity, bootstrap lead office). Two regression tests added. db:generate produced no migration artifact but is blocked by existing Drizzle config/meta setup before diffing.
- D CODEX-FIX-3 2026-05-08T03:21Z: PR #163 force-pushed with two more Codex fixes (role-based default scope on both pages, recent-deal-movement scope-awareness). Five regression tests added.
- A2 CODEX-FIX-3 2026-05-08T04:00Z: PR #161 force-pushed with four more Codex fixes (estimate alias write-path, bootstrap upsert, office_code immutability, project_number Drizzle parity). Four regression tests added.
- D CODEX-FIX-4 2026-05-08T04:03Z: PR #163 force-pushed with rep-scope ordering fix (P1) and audit of previously-added tests for implicit role assumptions. Two P2 catches deferred to follow-up issues. Test count: 20 tests passing across deal-list-page, lead-list-page, task-list-page.
- D CODEX-FIX-5 2026-05-08T04:47Z: PR #163 force-pushed with six fixes (P1 board team-scope alignment, P2 terminal drill-down parity, P2 recent leads filter, P2 task error handling, P2 terminal task no-op, P3 Space preventDefault). Six regression tests added. Two prior deferred follow-ups now fixed in-PR.
- D CODEX-FIX-6 2026-05-08T05:25Z: PR #163 force-pushed with four fixes (P1 stage scope normalization, P2 task row nested interactives, P2 terminal task focus, P2 deal card company name). Regression tests added. Chat context was lost mid-task; resumed cleanly.
- A2 CODEX-FIX-4 2026-05-08T05:59:58Z: PR #161 force-pushed with four fixes (P2 office_code seed parity, P2 deal_id Drizzle FK, P3 negative rounding, P3 deal_contacts indexes). Four regression tests added. Fresh DB apply verified.
- D CODEX-FIX-7 2026-05-08T06:04Z: PR #163 force-pushed with two fixes (P2 auth race in scope, P2 tasks assignee scoping restored). One P3 YTD year-rollover deferred to follow-up issue. Regression tests added.
- A2 CODEX-FIX-5 2026-05-08T14:18:28Z: PR #161 force-pushed with five fixes (P1 orphan FK guard, P2 office_code 422, P2 rate precision, P1 negative rounding). Four regression tests added. Fresh DB apply verified.
- D CODEX-FIX-8 2026-05-08T14:21Z: PR #163 force-pushed with four fixes (P2 tasks auth race, P2 useDeals stale-response, P2 pipeline board assigneeRepName, P2 YTD year rollover). Four regression tests added. Previously-deferred YTD issue resolved in-PR.
- A2 CODEX-FIX-6 2026-05-08T15:17:32Z: PR #161 force-pushed with one fix (P2 office_code normalization). Three P3 catches deferred to follow-up issues (#169, #170). Four regression tests added.
- D CODEX-FIX-9 2026-05-08T15:23Z: PR #163 force-pushed with five fixes (P1 listLeads office scoping cross-tenant leak, P2 scope+assignedRepId combine, P2 useLeads stale-response, P2 completedThisWeek window, P3 visibility badge total). Five regression tests added.
- HOTFIX-POSTMERGE CLAIM 2026-05-08T16:47:17Z: hotfix/postmerge-track-d, four production bugs from PR #163. Worktree: trockcrm-hotfix-postmerge.
- HOTFIX-POSTMERGE PR-OPEN 2026-05-08T16:48:15Z: PR https://github.com/artificialadnaan/trockcrm/pull/175.
- HOTFIX-POSTMERGE LIVE 2026-05-08T17:05:27Z: PR #175 merged to main at d9e482d; Railway API production deployment 2c3a042d-7e5b-40e2-9283-e319a8473418 succeeded.
- HOTFIX-POSTMERGE REVIEW2 2026-05-08T17:19:51Z: hotfix/postmerge-track-d-review2, Codex iteration-2 revisions for reports role allowlist and empty-office unassigned deal fallback. Worktree: trockcrm-hotfix-postmerge-r2.
- HOTFIX-2 CLAIM 2026-05-08T17:40:19Z: hotfix/phase1-property-constraints, two production bugs from PR #174 (mixed_use constraint, missing TENANT_SCHEMA block). Worktree: trockcrm-hotfix-phase1.
- HOTFIX-2 PR-OPEN 2026-05-08T17:43:24Z: PR https://github.com/artificialadnaan/trockcrm/pull/178.
