# Redesign Execution Plan — Parallel Agents

> **Status**: planning only. No code changes. Audit branch `audit/functional-2026-05` is paused for the duration of this push and is not touched by any track here.
>
> **Companion docs**: `.agents/redesign-context.md` (canonical spec), `.agents/redesign-status.md` (live coordination), `.agents/redesign-gap-audit.md` (Track A's per-field work order — see §2 Track 0).
>
> **Integration branch**: `chore/impeccable-design-baseline` (current). Every track branches off it and PRs back into it. That branch is the only thing that ever merges to `main`, behind a feature flag.

---

## 1. Workstream decomposition

The redesign decomposes into **7 tracks** plus a setup track. Confirmed against actual preview imports:

- Every page preview imports from `preview-shared.tsx` (`MetricCard`, `ScopeToggle`, `ActivityTimeline`, `DetailTabs`, `EYEBROW`, formatters).
- Detail pages (`company-detail`, `contact-detail`, `property-detail`, `deal-detail`) and `email-preview` additionally import `EmailList` / `RecordingsList` from `comms-preview.tsx`.
- Detail pages and `files-page-preview` import `FilesView` from `files-preview.tsx`.
- **No page-to-page imports.** Pages are siblings that depend only on (a) shared primitives and (b) hooks. That's the seam we split on.

Hypothesis revisions made during planning:
- Schema+hooks initially planned as a single backend track. **Revised**: split into A-core (sequential, contains every dependency-chained migration) and A-isolated (A4 reports + A5a snapshots, both genuinely independent of A-core's chain). Two backend agents in parallel.
- Shared primitives + comms + files-view + shell lightening become a single Track B (all pure UI components). **Revised**: B's deliverable also includes a throwaway harness page so prop-shape mismatches surface inside Track B before C/D/E/F start consuming primitives.
- Page ports split into 3 tiers by data dependency (lists, workflow, detail) plus a specialty track for director/email/reports/commissions.

| Track | Name | Branch | Worktree |
|---|---|---|---|
| 0 | Setup + status doc + gap audit | `redesign/coordination` | (this worktree) |
| A-core | Schema + hooks (Tier 1 → Tier 3 → Tier 4 sequential) | `redesign/schema-hooks-core` | `/Users/adnaaniqbal/projects/trockcrm-redesign-data` |
| A-isolated | Reports infra + perf snapshot table | `redesign/schema-hooks-isolated` | `/Users/adnaaniqbal/projects/trockcrm-redesign-data-isolated` |
| B | Shared primitives + shell + harness | `redesign/shared-primitives` | `/Users/adnaaniqbal/projects/trockcrm-redesign-shared` |
| C | List pages (no detail) | `redesign/list-pages` | `/Users/adnaaniqbal/projects/trockcrm-redesign-lists` |
| D | Workflow pages (deals/leads board, tasks, files) | `redesign/workflow-pages` | `/Users/adnaaniqbal/projects/trockcrm-redesign-flow` |
| E | Detail pages (4 detail surfaces) | `redesign/detail-pages` | `/Users/adnaaniqbal/projects/trockcrm-redesign-detail` |
| F | Specialty pages (director, email, reports, commissions) | `redesign/specialty-pages` | `/Users/adnaaniqbal/projects/trockcrm-redesign-specialty` |
| Z | Rollout (feature flag, polish, mobile pass, personal smoke, T Rock flip) | `redesign/rollout` | (this worktree, after merges) |

Tracks 0 / A-core / A-isolated / B run first in parallel. C/D/E/F run after their prereqs, in parallel with one another.

---

## 2. Per-track agent assignment

### Track 0 — Coordination

**Agent role:** Setup. Single short session, runs from this worktree (no new worktree needed).
**Branch:** `redesign/coordination`. PR'd first.

**Owns (writes):**
- `.agents/redesign-status.md` — live claim/release doc (format below)
- `.agents/redesign-gap-audit.md` — per-field map from preview render → hook return shape → schema column, marked `READY` / `HOOK GAP` / `SCHEMA GAP` / `DERIVED`. **Track A-core and A-isolated use this as their work order.** Without it, Track A is guessing at schema specifics.
- `.agents/redesign-execution-plan.md` — this file; updates are PR'd separately after Track 0 merges

**Must not touch:** Anything else.

**Dependencies:** None.

**Deliverable:** Single PR adding all three docs. Merges immediately.

---

### Track A-core — Schema + Hooks (sequential)

**Agent role:** Backend. One agent. Owns the dependency-chained migrations and hook extensions.

**Worktree:** `/Users/adnaaniqbal/projects/trockcrm-redesign-data` (new).
**Branch:** `redesign/schema-hooks-core` off `chore/impeccable-design-baseline`.
**Work order:** `.agents/redesign-gap-audit.md` (the SCHEMA GAP and HOOK GAP entries scoped to A-core below).

**Owns (writes):**
- `shared/src/schema/{companies,contacts,properties,deals,emails,files,call-recordings,leads}.ts` plus new schemas: `estimate_line_items`, `email_links`, `file_links`, `user_starred_files`
- Migrations for those entities only (under `migrations/`)
- `shared/src/types/**` updates that follow these schema changes
- `server/src/modules/{companies,contacts,properties,deals,leads,emails,files,call-recordings,activities}/**`
- `client/src/hooks/use-{companies,contacts,properties,deals,leads,emails,files,activities}.ts` (extensions only — no UI consumers touched)
- `client/src/lib/api.ts` (only if a new endpoint or shape is needed)

**Must NOT touch:**
- `client/src/components/**`
- `client/src/pages/**`
- `client/src/preview/**`, `client/preview.html`, `client/src/preview-main.tsx`
- `.agents/redesign-context.md` (canonical spec, frozen)
- Anything owned by A-isolated (`reports`, `report_schedules`, `report_runs`, `rep_performance_snapshots`, related modules, related hooks)

**Dependencies:** None. Starts immediately.

**Sub-deliverables (each its own PR — sequential):**
1. **A1** — Tier 1 schema (companies/contacts/properties field additions per gap audit §1) + hook extensions for those three list hooks. Unblocks Track C.
2. **A2** — Tier 3 schema (`estimate_line_items` table + `useEstimateLineItems` hook). Unblocks Track E's deal detail Estimate tab.
3. **A3** — Tier 4 schema (`email_links` junction, `file_links` junction, `ai_suggestions` JSONB on emails, `topics` array on call_recordings, `user_starred_files` pivot) + hook extensions for `useEmails` / `useFiles`. Unblocks Track F's email page and Track E's cross-link chips.

PRs A1 → A2 → A3 merge in numeric order.

---

### Track A-isolated — Reports + Snapshots (parallel)

**Agent role:** Backend. Second agent. Owns the genuinely-independent backend work that doesn't depend on A-core's chain.

**Worktree:** `/Users/adnaaniqbal/projects/trockcrm-redesign-data-isolated` (new).
**Branch:** `redesign/schema-hooks-isolated` off `chore/impeccable-design-baseline`.
**Work order:** `.agents/redesign-gap-audit.md` (the entries scoped to A4 / A5a / A5b).

**Owns (writes):**
- New schemas: `reports`, `report_schedules`, `report_runs`, `rep_performance_snapshots`
- Migrations for those four tables (under `migrations/`, separate file numbers from A-core)
- `server/src/modules/{reports,dashboard,director}/**` (new files only — A-core doesn't touch these)
- `client/src/hooks/use-{reports,dashboard,director-dashboard,rep-performance}.ts` (rebuild/extend)
- `worker/src/**` for the new `rep-performance-rollup` cron job and `reports-execution` worker stub

**Must NOT touch:**
- Anything owned by A-core (companies/contacts/properties/deals/emails/files/leads/call-recordings schemas + their hooks/server modules)
- Same client-side bans as A-core

**Dependencies:**
- Starts immediately — A4 + A5a have zero dependencies on A-core.
- A5b (rollup query refinements that read from A-core's `companies.last_activity_at` and `properties.last_activity_at`) waits until **A1 merges**, then lands as a small follow-up PR.

**Sub-deliverables:**
1. **A4** — Tier 5 schema (`reports` + `report_schedules` + `report_runs`) + scheduler tick using existing `node-cron` + execution worker stub that records `report_runs` rows with `status='not_implemented'`. Real query execution is post-rollout. Unblocks Track F's reports page.
2. **A5a** — Tier 6 schema (`rep_performance_snapshots` table + indexes) + `rep-performance-rollup` worker job that writes empty/zero rows initially + `useDirectorDashboard` / `useRepPerformance` extensions returning the snapshot shape. Unblocks Track F's director dashboard scaffolding.
3. **A5b** — Refinement PR after A1 merges: rollup query reads from `companies.last_activity_at` / `properties.last_activity_at` to populate snapshot fields that need those joins. Unblocks Track F's director full data.

A4 and A5a can land in any order or be bundled. A5b is gated on A1.

---

### Track B — Shared Primitives + Shell + Harness

**Agent role:** Frontend, design-system. One agent. Pure presentational code, no backend dependency.

**Worktree:** `/Users/adnaaniqbal/projects/trockcrm-redesign-shared` (new).
**Branch:** `redesign/shared-primitives` off `chore/impeccable-design-baseline`.

**Owns (writes):**
- `client/src/components/shared/**` — production version of `preview-shared.tsx` exports:
  - `metric-card.tsx` (with tones green/blue/white, drenched red mode, accent variants)
  - `scope-toggle.tsx` (generic `ScopeToggle<T>`)
  - `detail-tabs.tsx` (icon-only with active label strip — final iteration)
  - `activity-timeline.tsx`
  - `eyebrow.tsx` (constant + `<Eyebrow>` wrapper)
  - `formatters.ts` (USD, USD_COMPACT, NUMBER_COMPACT)
- `client/src/components/comms/**` — production version of `comms-preview.tsx`:
  - `email-list.tsx`, `recordings-list.tsx`, plus shared types
- `client/src/components/files/files-view.tsx` — production version of `files-preview.tsx`'s `FilesView` (All/Photos/Documents subtabs)
- `client/src/components/layout/{sidebar,topbar,app-shell}.tsx` — lighten sidebar to white, add ⌘K chip on topbar (the shell change)
- **`client/src/components/__harness__/shared-primitives-harness.tsx`** — throwaway test harness. Renders every primitive (`MetricCard` in every tone/accent variant, `ScopeToggle` with multiple option counts, `DetailTabs` with the icon set used by company/contact/property/deal detail, `ActivityTimeline`, `EmailList` with linked + unassigned + sent rows, `RecordingsList`, `FilesView` with photos+docs combos) against mock data **shaped exactly like the hook return shapes documented in `.agents/redesign-context.md` §4**. Mounted as a route in the existing AppShell, gated by an env check or dev-only flag so it never ships to prod. Track Z2 deletes it.

**Must NOT touch:**
- Any page file under `client/src/pages/**`
- Anything under `server/`, `shared/`, `migrations/`, `worker/`
- `client/src/hooks/**` (primitives stay presentational; the harness imports mock data inline, never calls a hook)

**Dependencies:** None. Starts immediately.

**Deliverable:** Single PR. All page-port tracks are blocked on it landing. The harness page surfaces prop-shape mismatches inside Track B, not in C/D/E/F.

---

### Track C — List Pages (Tier 1)

**Agent role:** Frontend, page port. One agent.

**Worktree:** `/Users/adnaaniqbal/projects/trockcrm-redesign-lists` (new).
**Branch:** `redesign/list-pages` off `chore/impeccable-design-baseline` (rebase after A1 + B merge).

**Owns (writes):**
- `client/src/pages/dashboard/rep-dashboard-page.tsx` and its sub-components under `client/src/components/dashboard/` (continue the partial port already on branch)
- `client/src/pages/companies/company-list-page.tsx`
- `client/src/pages/contacts/contact-list-page.tsx`
- `client/src/pages/properties/property-list-page.tsx`
- Any list-only sub-components under `client/src/components/{companies,contacts,properties,dashboard}/` exclusively consumed by the list pages above (e.g. industry chip row, role chip row, stale-leads card)
- The list pages' `*.test.tsx` siblings

**Must NOT touch:**
- Detail-page files (`*-detail-page.tsx` and detail-only sub-components) — those are Track E
- Board pages (deals, leads) — those are Track D
- Anything in `client/src/components/shared/`, `client/src/components/comms/`, `client/src/components/files/` — those are Track B
- Anything outside `client/`

**Dependencies:** A1 (Tier 1 schema + extended `useCompanies` / `useContacts` / `useProperties`) **and** B (shared primitives + harness) must both have merged before this track starts UI work. Reading-only research can begin earlier.

**Deliverable:** Single PR with all four list pages.

---

### Track D — Workflow Pages

**Agent role:** Frontend, page port. One agent.

**Worktree:** `/Users/adnaaniqbal/projects/trockcrm-redesign-flow` (new).
**Branch:** `redesign/workflow-pages` off `chore/impeccable-design-baseline` (rebase after B merge; A1 not strictly required for tasks/deals/leads boards but rebase after if available).

**Owns (writes):**
- `client/src/pages/deals/deal-list-page.tsx` (kanban board + map view; map uses stub SVG initially, swap to Mapbox/Leaflet inside this PR or follow-up)
- `client/src/pages/leads/lead-list-page.tsx`
- `client/src/pages/tasks/task-list-page.tsx`
- `client/src/pages/files/files-page.tsx`
- Sub-components exclusively under `client/src/components/{deals,leads,tasks,files}/` that aren't already shared
- Test siblings

**Must NOT touch:**
- Deal detail / lead detail (Track E)
- Anything in shared/comms/files components dirs (Track B)
- Anything outside `client/`

**Dependencies:**
- B (shared primitives) — hard.
- A3 (Tier 4: `file_links` junction, files starred pivot) — required for `files-page.tsx` to render multi-entity link chips. Tasks, deals board, leads board can land before A3.
- Therefore: split this track into two PRs if A3 is late — D1 (deals/leads/tasks) and D2 (files page).

**Deliverable:** PR(s) per the split rule above.

---

### Track E — Detail Pages

**Agent role:** Frontend, page port. One agent. Heaviest single track because the deal detail page is the most complex preview.

**Worktree:** `/Users/adnaaniqbal/projects/trockcrm-redesign-detail` (new).
**Branch:** `redesign/detail-pages` off `chore/impeccable-design-baseline` (rebase after A2 + A3 + B).

**Owns (writes):**
- `client/src/pages/companies/company-detail-page.tsx`
- `client/src/pages/contacts/contact-detail-page.tsx`
- `client/src/pages/properties/property-detail-page.tsx`
- `client/src/pages/deals/deal-detail-page.tsx` (Bid Board banner + summary card + 6-slot pipeline progress + Estimate tab + Photos tab + Files tab)
- Detail-only sub-components under `client/src/components/{companies,contacts,properties,deals}/` (e.g. `bid-board-banner.tsx`, `pipeline-progress.tsx`, `estimate-line-item-table.tsx`, `stage-history-timeline.tsx`)
- Test siblings

**Must NOT touch:**
- List-page files (Track C / D)
- Shared/comms/files components dirs (Track B)
- Anything outside `client/`

**Dependencies:**
- B (shared primitives — `DetailTabs`, `MetricCard`, `ActivityTimeline`) — hard.
- A2 (`estimate_line_items` table + hook) — hard for the Estimate tab. Could ship deal detail without that tab and add it after A2.
- A3 (Tier 4 multi-entity linking) — needed for cross-link chips on every detail tab. Could ship without and add chips after A3.
- A1 (Tier 1 schema) — needed for company/contact/property detail metadata sidebars (industry, role, type, etc.).

**Deliverable:** Single large PR, OR split into E1 (company/contact/property — Tier 1 only) and E2 (deal detail — needs A2/A3) if scheduling demands.

---

### Track F — Specialty Pages

**Agent role:** Frontend, page port. One agent.

**Worktree:** `/Users/adnaaniqbal/projects/trockcrm-redesign-specialty` (new).
**Branch:** `redesign/specialty-pages` off `chore/impeccable-design-baseline` (rebase after each Tier-N PR merges).

**Owns (writes):**
- `client/src/pages/director/director-dashboard-page.tsx` (Forecast vs Goal, Sales Force Performance, At-Risk Deals, Strategic Alerts, AI Coaching, Activity Pulse, Recent Closes)
- `client/src/pages/email/email-inbox-page.tsx` (two-pane inbox + Assign popover)
- `client/src/pages/reports/reports-page.tsx` (Library/My/Scheduled/Recent, 16 fixture reports → real data)
- `client/src/pages/commissions/rep-commissions-page.tsx` (My + Team views)
- New admin commission route if needed (per spec — currently TBD)
- Sub-components under `client/src/components/{director,email,reports,commissions}/`
- Test siblings

**Must NOT touch:**
- Anything in other page tracks
- Shared/comms/files components dirs (Track B)
- Anything outside `client/`

**Dependencies:**
- B (shared primitives) — hard.
- A3 (Tier 4 — `ai_suggestions`, `email_links`) — hard for email page.
- A4 (Tier 5 — reports tables) — hard for reports page.
- A5a (Tier 6 — `rep_performance_snapshots`) — hard for director dashboard scaffold. A5b refinement adds the cross-entity rollup data after A1.
- Commissions can land earlier (uses existing `commissionSummary` plus a new per-deal commission breakdown — call out as a small additional A-core PR or piggyback on A5).

**Deliverable:** Four PRs (one per page) so each can rebase as its tier lands. Don't bundle.

---

### Track Z — Rollout

**Agent role:** Owner. Final step.

**Worktree:** This one (after all merges).
**Branch:** `redesign/rollout` off `chore/impeccable-design-baseline` (after A-core / A-isolated / B / C / D / E / F all merged).

**Sub-deliverables (sequenced):**

- **Z1** — Feature flag wiring (env var + `client/src/lib/feature-flags.ts`, plus toggle on each top-level redesigned route) + mobile responsive pass across every redesigned page. Lands disabled-by-default. PR'd into `chore/impeccable-design-baseline`, then merged into `main` with the flag off — zero behavior change for users.

- **Z1.5 — Personal smoke test (explicit, blocking step)**.
  - Trigger: Z1 has merged to `main`; redesign code is live but flag is off for everyone.
  - Action: human flips the flag for **their own user only** (per-user flag, not global) on production.
  - Walk: human navigates through every redesigned page against real production data — rep dashboard, director, deals list/board, leads list/board, companies list, contacts list, properties list, all 4 detail pages, email inbox, tasks, files page, reports, commissions. Both views where applicable (My/Team).
  - Watch for: hook return shapes that don't match what the page renders, missing sidebar fields, broken cross-links, blank tabs, console errors, mobile breakage on phone.
  - Exit: human signs off in writing (commit a `Z1.5 — personal smoke pass` line into `.agents/redesign-status.md` Track Z section, or comment on the Z1 PR).
  - **Block:** T Rock does not see the redesign until Z1.5 is signed off. If smoke reveals a bug, fix lands as a tiny PR into `chore/impeccable-design-baseline` and forward-merges to `main`, then Z1.5 reruns.

- **Z2** — After Z1.5 sign-off: flag flips on for T Rock users (still selectively — not the whole world). T Rock acceptance window opens. Post-acceptance fixes go through tiny PRs.

- **Z3** — After T Rock acceptance: full flag flip (all users), removal of `client/src/preview/`, `client/preview.html`, `client/src/preview-main.tsx`, removal of the `__harness__` page Track B added, removal of dead code in old page versions, README/CLAUDE.md notes for ops.

**Dependencies:** Every other track merged.

---

## 3. Critical path

```
Track 0 (status doc + gap audit + plan)
    │
    ├── Track A-core: A1 (Tier 1) ──┬──► Track C (list pages)
    │                               │
    ├── Track A-core: A2 (Tier 3) ──┴──► Track E (detail pages, partial: company/contact/property)
    │                               │
    ├── Track A-core: A3 (Tier 4) ──┴──► Track D2 (files page) + E (deal detail full) + F (email page)
    │
    ├── Track A-isolated: A4 (Tier 5, parallel from start) ──► Track F (reports page)
    │
    ├── Track A-isolated: A5a (snapshot table, parallel from start) ──► Track F (director dashboard scaffolding)
    │   then A5b (rollup refinement, after A1) ────────────────────► Track F (director full data)
    │
    └── Track B (shared primitives + harness) ────────────────────► All page tracks
                                                                    │
                                                                    └──► Track Z1 → Z1.5 → Z2 → Z3
```

**Pages that can start before any A-tier schema lands** (B alone is enough):
- Tasks page (no schema changes — `useTasks` already correct)
- Deals list/board (`useDealBoard` already correct)
- Leads list/board (`useLeadBoard` already correct — drop the legacy `opportunity` lead stage from view)

**Pages that wait for A1**: Companies list, Contacts list, Properties list, Rep dashboard polish (industry/role/type chips, last_activity_at coloring).

**Pages that wait for A2**: Deal detail's Estimate tab.

**Pages that wait for A3**: Email page, Files page, all detail-page cross-link chips.

**Pages that wait for A4**: Reports page.

**Pages that wait for A5a**: Director dashboard (scaffold). **A5b**: Director dashboard full data.

**Bottleneck**: Track A-core is the long pole (3 sequential PRs). A-isolated finishes faster because A4 and A5a are independent. B finishes fastest. Run all four start-tracks in parallel and start C/D the moment A1 + B merge. E and F begin partial work after their first tier dependency lands.

---

## 4. Coordination protocol — `.agents/redesign-status.md`

Single file. Every agent reads it before claiming work and writes one line when claiming or releasing. Stale claims are obvious because the timestamp ages — anything older than 24h with no follow-up is treated as abandoned and may be reclaimed after the human confirms.

**Format:**

```markdown
# Redesign Status

> Living coordination doc. Each agent: read before claiming, write a line when claiming or releasing. Use 24h-clock UTC timestamps.

## Track 0 — Coordination
- 2026-05-07T17:30Z [main-agent] PR-OPEN — initial plan revision + status + gap audit (PR #150)

## Track A-core — Schema + Hooks
- _no claims yet_

## Track A-isolated — Reports + Snapshots
- _no claims yet_

## Track B — Shared Primitives
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
```

**Line format** (single line per claim/release):
```
YYYY-MM-DDTHH:MMZ [agent-label] STATUS — short description (PR #__ if open)
```

`STATUS` is one of `CLAIM` / `WIP` / `BLOCKED` / `PR-OPEN` / `MERGED` / `ABANDONED`. `agent-label` is whatever the human assigns when they spin up the agent (e.g. `track-a-core-agent`, `claude-shared`, `codex-detail`).

**Rules:**
- A track can have multiple sub-PRs in flight (e.g. A1, A2). Use one line per sub-PR.
- Never edit another agent's line. Append a new one.
- If you need to release a claim without finishing, write an `ABANDONED` line with reason. Don't silently disappear.
- The human is the final referee on stale claims.

---

## 5. Merge strategy

**All PRs target `chore/impeccable-design-baseline`.** Nothing merges directly to `main` until Track Z1 lands.

**Merge order (lowest conflict cost first):**

1. **Track 0 PR** — adds status + gap audit + revised plan. Merges first.
2. **Track A1 PR (A-core)** + **Track A4 PR (A-isolated)** + **Track A5a PR (A-isolated)** + **Track B PR** — all four can land in any order; they touch disjoint files. A1 should land first so C can unblock.
3. **Track A2 PR (A-core)** — Tier 3 schema. Sequential after A1.
4. **Track A3 PR (A-core)** — Tier 4 schema. Sequential after A2.
5. **Track A5b PR (A-isolated)** — rollup refinement. Sequential after A1.
6. **Track C PR** — page replacements. Conflict surface = each page file. No other track writes to those four files.
7. **Track D PRs** — separate page files. No collision with C/E/F.
8. **Track E PR(s)** — separate page files. No collision with C/D/F.
9. **Track F PRs** — separate page files. Director and reports only land after their Tier dependency.
10. **Track Z1 → Z1.5 → Z2 → Z3** — last. Z1.5 is a human action, not a code merge.

**Conflict zones to watch:**
- `migrations/` — A-core and A-isolated both write here. Use distinct file numbers (A-core takes the next sequential number; A-isolated takes the one after) and rebase before push to keep numbering monotonic.
- `client/src/lib/api.ts` — Track A-core and A-isolated may both add endpoints; if any page track also adds an endpoint helper, it must rebase.
- `client/src/components/dashboard/funnel-bucket-card.tsx` — already modified on branch (No-Float fix). Track C touches dashboard sub-components; coordinate.
- `client/src/components/layout/*.tsx` — only Track B writes here.
- `shared/src/types/index.ts` — both A-core and A-isolated write. Resolve barrel-export conflicts via additive-only edits.

**Per-track rebase cadence:** rebase the working branch off `chore/impeccable-design-baseline` after every upstream merge. If a rebase produces a conflict, the agent resolves it in its own worktree before pushing again. Never force-push someone else's branch.

**Final merge to `main`:**
- After Track Z1 merges into baseline, open a PR from `chore/impeccable-design-baseline` → `main`.
- Merge it disabled-by-default. Smoke test on Railway with the flag off.
- **Z1.5**: human flips the flag for own user only on prod, walks every page, signs off. Block until done.
- **Z2**: flag flips on for T Rock users.
- **Z3**: full flag flip + cleanup PR.

---

## 6. Risk register (parallel-agent specific)

Re-evaluated against the parallel workflow. New risks marked **NEW**.

| # | Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|---|
| 1 | **NEW** Concurrent writes to same file across tracks | Medium | High — silent data loss if a worktree's `git pull` doesn't fast-forward | File-ownership table in §2 is the contract. CI on baseline runs typecheck on every PR. Agent must rebase before push. |
| 2 | **NEW** Two tracks both need to extend the same hook | Medium | Medium — last writer wins | Hooks are owned by Track A-core (entity hooks) or A-isolated (reports/director/perf hooks) only. Page tracks request hook fields via PR review; the relevant A track adds them. No page track modifies a hook file. |
| 3 | **NEW** Migration file number collisions between A-core and A-isolated | Medium | Medium — broken `drizzle-kit migrate` order | Each A-track rebases against latest baseline before generating a migration. The second writer to merge bumps their file number on rebase. CI runs migrate against a clean DB on every PR. |
| 4 | **NEW** Untracked-file wipe (the May 7 incident) | Low if rules followed | Very high | Rule: every track commits and pushes at least every 2 hours. No `git clean`, `git reset --hard`, `git stash --include-untracked` in any worktree. |
| 5 | **NEW** Branch-worktree binding violation | Low | High — git refuses, but agent may try `git checkout -B` and clobber | Each track has its own dedicated worktree path under §2. Agent runs `git worktree list` before starting. |
| 6 | **NEW** Agent picks the wrong worktree (e.g. starts in this worktree by accident) | Low | High — could write to wrong branch | Each agent's spawn prompt includes the exact worktree path and `cd` to it as the first step. Agent runs `git branch --show-current` to verify before any write. |
| 7 | Schema migration order with running services | Medium | Medium | A-track migrations are individually idempotent (per CLAUDE.md project rules). Each tier ships its own migration. Run `npx drizzle-kit migrate` as a build step, not server start. |
| 8 | Type drift between `shared/src/types` and `client/src/hooks` | Medium | Medium — runtime errors at field reads | A-core / A-isolated are the only writers. Typecheck (`tsc --noEmit`) runs in CI before any PR can merge. |
| 9 | Bid Board mirror fields renamed during the redesign | Low | High — redesign assumes existing field names | Spec is locked to current field names in `.agents/redesign-context.md`. Any rename happens in a separate post-redesign PR. |
| 10 | Mapbox/Leaflet pick for deals map view delays Track D | Medium | Low — fall back to stub SVG, swap later | Track D ships stub map. Real map is a follow-up PR after rollout. |
| 11 | Reports execution worker scope creep | Medium | Medium — reports infra is large | A4 ships only the schema + scheduler tick + execution stub. Real execution is a Tier 5 follow-up after rollout. |
| 12 | Director performance snapshot rollup is slow at first | Medium | Low | A5a includes indexes on `deals.stage_entered_at`, `activities.occurred_at`, `deals.assigned_rep_id`. Backfill job runs once on deploy. |
| 13 | Feature flag leaks between users | Low | Medium — old UI shows after acceptance | Z1 wires flag via existing user/role context, not a global toggle. Z1.5 verifies per-user isolation before T Rock sees it. |
| 14 | Z1.5 reveals bugs that block T Rock | High (this is normal) | Low if caught here, Very high if missed | Z1.5 is explicit and blocking by design. Better to fail at Z1.5 than at Z2. |
| 15 | Preview files get out of sync with production ports | Medium during transition | Low | Preview files are design intent only. Track Z3 removes them. Don't keep both. |
| 16 | **NEW** Track B harness drifts from real hook shapes | Low | Medium — primitives might pass harness but break real pages | Harness mock data is shaped to match `.agents/redesign-context.md` §4 verbatim. If a hook return shape changes during A-track work, B updates the harness mocks in a follow-up PR. |

---

## 7. What happens next (after this plan is approved)

1. Human reviews this plan.
2. Track 0 lands `.agents/redesign-status.md` + `.agents/redesign-gap-audit.md` + this revised plan as a single PR from this worktree.
3. Human spins up four agents in parallel: A-core, A-isolated, B, and (optionally) C in research-only mode.
4. As A1 + B merge, human unblocks Track C and the partial Track D / Track E.
5. As A2 / A3 / A4 / A5a / A5b merge, human unblocks remaining E, D-files, and F sub-PRs.
6. Track Z1 lands behind a flag. Z1.5 is the human's blocking smoke test. Z2 opens T Rock acceptance. Z3 cleans up.

No track writes to `chore/impeccable-design-baseline` directly. Every change is a PR. Every merge is reviewed.
