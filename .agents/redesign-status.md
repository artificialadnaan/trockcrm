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
- _no claims yet_

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
- A2 CODEX-FIX 2026-05-07T23:35Z: PR #161 force-pushed with two data-integrity fixes (estimate alias backfill rewrite, deal_contacts unique key + dedupe). Two regression tests added. Fresh DB apply against post-fix SHA verifies the new constraint shape.
- A2 CODEX-FIX-2 2026-05-08T03:17Z: PR #161 force-pushed with two more Codex fixes (Drizzle schema parity, bootstrap lead office). Two regression tests added. db:generate produced no migration artifact but is blocked by existing Drizzle config/meta setup before diffing.
- A2 CODEX-FIX-3 2026-05-08T04:00Z: PR #161 force-pushed with four more Codex fixes (estimate alias write-path, bootstrap upsert, office_code immutability, project_number Drizzle parity). Four regression tests added.
- A2 CODEX-FIX-4 2026-05-08T05:59:58Z: PR #161 force-pushed with four fixes (P2 office_code seed parity, P2 deal_id Drizzle FK, P3 negative rounding, P3 deal_contacts indexes). Four regression tests added. Fresh DB apply verified.
- A2 CODEX-FIX-5 2026-05-08T14:18:28Z: PR #161 force-pushed with five fixes (P1 orphan FK guard, P2 office_code 422, P2 rate precision, P1 negative rounding). Four regression tests added. Fresh DB apply verified.
- A2 CODEX-FIX-6 2026-05-08T15:17:32Z: PR #161 force-pushed with one fix (P2 office_code normalization). Three P3 catches deferred to follow-up issues (#169, #170). Four regression tests added.
