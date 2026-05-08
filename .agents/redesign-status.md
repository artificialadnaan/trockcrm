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

## Track A-isolated — Reports + Snapshots (A4 + A5a parallel; A5b after A1)
- 2026-05-07T19:16Z [track-a-isolated-agent] CLAIM — A4 in flight (branch: redesign/schema-hooks-isolated/a4)
- 2026-05-07T19:29Z [track-a-isolated-agent] PR-OPEN — A4 (PR #156)
- 2026-05-07T19:31Z [track-a-isolated-agent] CLAIM — A5a in flight (branch: redesign/schema-hooks-isolated/a5a)
- 2026-05-07T20:27Z [track-a-isolated-agent] PR-OPEN — A5a (PR #158)

## Track B — Shared Primitives + Shell + Harness
- _no claims yet_

## Track C — List Pages
- _no claims yet_

## Track D — Workflow Pages
- _no claims yet_

## Track E — Detail Pages
- _no claims yet_

## Track F — Specialty Pages
- _no claims yet_

## Track Z — Rollout
- _no claims yet_

## Cross-track risks (live)
- _no risks logged_

## Track B — Shared Primitives + Shell + Harness
- 2026-05-07T18:34Z [track-b-agent] CLAIM — single PR in flight (branch: redesign/shared-primitives)
- 2026-05-07T18:49Z [track-b-agent] PR-OPEN — shared primitives + shell + harness ready for review (PR #154)
- D CLAIM 2026-05-07T22:21Z: redesign/workflow-pages, deals board + leads board + tasks page (PR 1), files page deferred to PR 2 post-A2. ETA TBD. Worktree: trockcrm-redesign-flow.
- D PR-OPEN-DRAFT 2026-05-07T23:01Z: PR https://github.com/artificialadnaan/trockcrm/pull/163, /deals + /leads + /tasks. DRAFT until deals-pipeline office filter hotfix merges. /files deferred to PR 2.
- D PR-READY 2026-05-07T23:06Z: PR #163 marked ready for review. Original "blocker" was a misread of intentional cross-office visibility on deals-pipeline; director-scoping bug is a separate main-targeting hotfix and does not gate Track D.
- D CODEX-FIX 2026-05-07T23:15Z: PR #163 force-pushed with two SPA-state regression fixes (leads bucket filter, terminal date filter staleness). Two regression tests added.
- D CODEX-FIX-2 2026-05-07T23:39Z: PR #163 force-pushed with three additional Codex fixes (Won YTD window, lead listLeads scope full-stack, task row keyDown propagation). Track D scope expanded to include backend listLeads change. Three regression tests added (backend listLeads scope + two frontend).
- D CODEX-FIX-3 2026-05-08T03:21Z: PR #163 force-pushed with two more Codex fixes (role-based default scope on both pages, recent-deal-movement scope-awareness). Five regression tests added.
- D CODEX-FIX-4 2026-05-08T04:03Z: PR #163 force-pushed with rep-scope ordering fix (P1) and audit of previously-added tests for implicit role assumptions. Two P2 catches deferred to follow-up issues. Test count: 20 tests passing across deal-list-page, lead-list-page, task-list-page.
