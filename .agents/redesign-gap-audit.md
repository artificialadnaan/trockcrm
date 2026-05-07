# Redesign Gap Audit

> Per-field map from preview render → hook return shape → schema column. **Track A-core and A-isolated use this as their work order.** Pages list every render; gap entries name the migration / hook extension / derivation needed. Without this audit, Track A is guessing at schema specifics.
>
> **Cross-references**: `.agents/redesign-context.md` §1 (per-page specs), §4 (hook map), §5 (schema map). This file is the diff between what previews render and what production currently provides.

## Legend

- **READY** — schema column exists and the hook already returns it; preview consumes as-is.
- **HOOK GAP** — schema column exists, hook does not return it. Track A extends the hook only.
- **SCHEMA GAP** — schema column does not exist. Track A creates migration + backend query + hook field.
- **DERIVED** — value is computed (client-side or server-side aggregation/expression). No migration; the server query computes it (preferred for query-shape stability) or the page computes it from existing fields.

---

## §1 Schema gaps by entity (Track A's migration list)

### `companies` — Tier A1 (Track A-core / PR A1)
- `industry` — postgres enum `company_industry` `[school_district | healthcare | industrial | office_mixed | retail | government | hospitality]`. Used by `/companies` filter chips, `/companies` table column, `/companies/:id` hero eyebrow + sidebar. **SCHEMA GAP**.
- `region` — text. `/companies/:id` sidebar, `/companies` optional column. **SCHEMA GAP**.
- `domain` — text. `/companies/:id` sidebar (mono font), `/companies` derived for "Open in HubSpot" hint. **SCHEMA GAP**.
- `last_activity_at` — timestamptz. `/companies` table column with red-tint when stale 30d+, `/companies/:id` activity timeline empty-state. **SCHEMA GAP** (alternative: a view that aggregates from `activities` — Track A picks a column with a trigger for query speed).
- `hubspot_id` — text. `/companies` footer "Open in HubSpot", `/companies/:id` sidebar System IDs. **SCHEMA GAP**.
- `procore_id` — text. `/companies/:id` sidebar System IDs (mono). **SCHEMA GAP**.

### `contacts` — Tier A1 (Track A-core / PR A1)
- `role` — postgres enum `contact_role` `[decision_maker | influencer | gatekeeper | procurement | engineer | owner]`. `/contacts` filter chips + table role pill, `/contacts/:id` hero eyebrow + sidebar. **SCHEMA GAP**.
- `is_primary` — boolean default false. `/contacts` table star icon on row, `/contacts/:id` amber "Primary" pill in hero. **SCHEMA GAP**.
- `linkedin_url` — text. `/contacts/:id` sidebar external link. **SCHEMA GAP**.
- `hubspot_id` — text. `/contacts/:id` sidebar System IDs. **SCHEMA GAP**.

### `properties` — Tier A1 (Track A-core / PR A1)
- `type` — postgres enum `property_type` `[office | industrial | retail | school | healthcare | government | mixed_use]`. `/properties` filter chips + table type pill, `/properties/:id` hero eyebrow + sidebar. **SCHEMA GAP**.
- `floors` — int. `/properties/:id` Building Specs 3-up. **SCHEMA GAP**.
- `roof_area` — int (sq ft). `/properties/:id` "Roof area" red-accent metric, sidebar. **SCHEMA GAP**.
- `last_activity_at` — timestamptz. `/properties` table column tint, `/properties/:id` sidebar. **SCHEMA GAP** (same trigger pattern as companies).
- `procore_id` — text. `/properties/:id` sidebar + Procore link. **SCHEMA GAP**.
- `companycam_id` — text. `/properties/:id` sidebar + CompanyCam button. **SCHEMA GAP**.

### `estimate_line_items` — Tier A2 (Track A-core / PR A2, NEW table)
Columns:
- `id` uuid PK default gen_random_uuid()
- `deal_id` uuid FK → deals(id) ON DELETE CASCADE, indexed
- `label` text NOT NULL
- `qty` numeric(12,2) NOT NULL default 1
- `unit` text (e.g. "ea", "sq ft", "hr")
- `rate` numeric(12,2) NOT NULL default 0
- `total` numeric(14,2) NOT NULL default 0  *(or computed via generated column = qty * rate)*
- `sort_order` int NOT NULL default 0
- `created_at` timestamptz NOT NULL default now()
- `updated_at` timestamptz NOT NULL default now()

Used by `/deals/:id` Estimate tab table + footer total. **SCHEMA GAP**.
New hook: `useEstimateLineItems(dealId)` returning `{ items[], total, loading, error, refetch }`.

### `email_links` — Tier A3 (Track A-core / PR A3, NEW junction)
Columns:
- `id` uuid PK
- `email_id` uuid FK → emails(id) ON DELETE CASCADE
- `entity_type` text — one of `deal | lead | contact | company | property`
- `entity_id` uuid (no FK — polymorphic)
- `confidence` numeric(3,2) — for AI-suggested vs human-confirmed
- `created_at` timestamptz default now()
- `created_by` uuid FK → users(id) nullable (null = AI/system)
- UNIQUE(email_id, entity_type, entity_id)
- INDEX(entity_type, entity_id) for reverse lookup ("which emails are linked to this deal?")

Used by `/email` left-pane status pill, right-pane Linked-to bar with multi-entity chips, every detail-page Email tab's filter. **SCHEMA GAP**.

Migration note: keep the existing `emails.assigned_entity_type` / `emails.assigned_entity_id` columns for backward-compat with existing data; populate `email_links` rows from those single FKs as part of the migration (one-time backfill).

### `emails` columns added — Tier A3 (Track A-core / PR A3)
- `ai_suggestions` jsonb — array of `{ type, id, name, confidence }`. `/email` Assign popover AI suggestions strip. **SCHEMA GAP**.

### `call_recordings` columns added — Tier A3 (Track A-core / PR A3)
- `topics` text[] (or jsonb array). `RecordingsList` topic chips on detail-page Recordings tabs. **SCHEMA GAP**.

### `file_links` — Tier A3 (Track A-core / PR A3, NEW junction)
Columns:
- `id` uuid PK
- `file_id` uuid FK → files(id) ON DELETE CASCADE
- `entity_type` text — one of `deal | lead | contact | company | property`
- `entity_id` uuid
- `created_at` timestamptz default now()
- UNIQUE(file_id, entity_type, entity_id)
- INDEX(entity_type, entity_id)

Used by `/files` linked-to chips (multi-entity), every detail-page Files tab. **SCHEMA GAP**.
Migration: backfill from existing `files.deal_id` / `files.lead_id` / `files.contact_id` single FKs. Keep originals for backward-compat.

### `user_starred_files` — Tier A3 (Track A-core / PR A3, NEW pivot)
Columns:
- `user_id` uuid FK → users(id) ON DELETE CASCADE
- `file_id` uuid FK → files(id) ON DELETE CASCADE
- `starred_at` timestamptz NOT NULL default now()
- PRIMARY KEY(user_id, file_id)

Used by `/files` page Starred toggle, file cards' starred badge, sort-by-starred. **SCHEMA GAP**.

### `reports` — Tier A4 (Track A-isolated / PR A4, NEW table)
Columns:
- `id` uuid PK
- `slug` text UNIQUE NOT NULL — stable identifier for built-ins ("team_lead_weekly", "win_rate_trend", etc.)
- `title` text NOT NULL
- `category` enum `report_category` `[sales | performance | operations | analytics]`
- `kind` enum `report_kind` `[snapshot | trend | leaderboard | export | custom]`
- `description` text
- `owner_id` uuid FK → users(id) nullable (null = system/built-in)
- `default_filters` jsonb default '{}'
- `is_built_in` bool default false
- `created_at` / `updated_at`

Used by `/reports` Library tab cards. **SCHEMA GAP**. Seed the 16 fixture reports from `.agents/redesign-context.md` §1 `/reports` section as built-ins in the migration.

### `report_schedules` — Tier A4 (Track A-isolated / PR A4, NEW table)
Columns:
- `id` uuid PK
- `report_id` uuid FK → reports(id) ON DELETE CASCADE
- `frequency` enum `report_frequency` `[daily | weekly | biweekly | monthly | quarterly]`
- `cron_expr` text — derived from frequency or custom
- `recipients` jsonb — array of `{ user_id?, email? }` for delivery
- `next_run_at` timestamptz
- `last_run_at` timestamptz nullable
- `owner_id` uuid FK → users(id)
- `is_active` bool default true
- `created_at` / `updated_at`

Used by `/reports` Scheduled tab. **SCHEMA GAP**.

### `report_runs` — Tier A4 (Track A-isolated / PR A4, NEW table)
Columns:
- `id` uuid PK
- `report_id` uuid FK → reports(id) ON DELETE CASCADE
- `schedule_id` uuid FK → report_schedules(id) nullable
- `started_at` timestamptz NOT NULL default now()
- `finished_at` timestamptz nullable
- `status` enum `report_run_status` `[queued | running | succeeded | failed | not_implemented]`
- `result_uri` text nullable — pointer to generated artifact
- `error` text nullable
- `runtime_ms` int nullable

Used by `/reports` Recent tab list (run count, runtime, "Re-run" button). **SCHEMA GAP**.

Worker: `reports-execution` cron stub that picks up rows with `status='queued'`, marks them `running`, then `not_implemented` (real execution is post-rollout per §11 risk).

### `rep_performance_snapshots` — Tier A5a (Track A-isolated / PR A5a, NEW rollup table)
Columns:
- `id` uuid PK
- `rep_id` uuid FK → users(id), indexed
- `period_kind` enum `perf_period_kind` `[mtd | qtd | ytd | last_month | last_quarter | last_year | week_8back]`
- `period_start` date
- `period_end` date
- `pipeline_value` numeric(14,2) default 0
- `closed_value` numeric(14,2) default 0
- `deals_count` int default 0
- `wins_count` int default 0
- `losses_count` int default 0
- `win_rate` numeric(5,2) — store computed for query-time stability (deals_count = wins + losses + open)
- `at_risk_count` int default 0
- `activity_total` int default 0
- `calls` / `emails` / `meetings` / `notes` int defaults 0
- `sparkline_8w` jsonb — array of 8 weekly closed-value ints
- `region` text — denormalized for filter speed
- `computed_at` timestamptz NOT NULL default now()
- INDEX(rep_id, period_kind, period_start)

Used by `/director` Sales Force Performance table, rep sparklines, Activity Pulse, At-Risk count chips. **SCHEMA GAP**.

Worker: `rep-performance-rollup` cron — refresh every period_kind nightly, plus on-demand refresh per rep.

### A5b refinement (Track A-isolated, after A1 merges)
No new columns. The `rep-performance-rollup` query gains joins onto `companies.last_activity_at` and `properties.last_activity_at` for fields like "stale account count per rep". Lands as a small follow-up PR once A1 has merged.

---

## §2 Hook gaps by hook (Track A's hook extension list)

### `useRepDashboard` — Track A-core (already complete enough; verify only)
Already returns: `activeLeads`, `activeDeals`, `contractsSignedYtd/Mtd`, `tasksToday`, `activityThisWeek`, `followUpCompliance`, `pipelineByStage`, `staleLeads`, `leadSnapshot`, `dealSnapshot`, `myCleanup`, `crmOwnedProgression`, `downstreamBottlenecks`, `commissionSummary`, `funnelBuckets`, `fetchedAt`. Preview adds nothing — **READY**.

### `useCompanies` — extend after A1 (Track A-core)
Add to row shape: `industry`, `region`, `domain`, `last_activity_at`, `hubspot_id`, `procore_id`. Add **DERIVED** aggregates: `properties_count`, `contacts_count`, `active_deals_count`, `pipeline_value`. **HOOK GAP** for the new columns + DERIVED aggregates.

### `useContacts` — extend after A1 (Track A-core)
Add: `role`, `is_primary`, `linkedin_url`, `hubspot_id`. **DERIVED**: `linked_deals_count`, `last_touch_at` (max from activities + emails + tasks per contact). **HOOK GAP**.

### `useProperties` — extend after A1 (Track A-core)
Add: `type`, `floors`, `roof_area`, `last_activity_at`, `procore_id`, `companycam_id`. **DERIVED**: `engagement_status` (active deal / active lead / won / no engagement, computed from deals + leads), `linked_value` (sum of active-deal value), `photos_count` (count of files where category in photo enum). **HOOK GAP**.

### `useDealBoard` — Track A-core (verify only)
columns + cards + days_in_stage all present — **READY**. Verify cards include `propertyLat` / `propertyLng` for the Map view; if not, **HOOK GAP** (small extension).

### `useDeals` — Track A-core (verify only)
Add **DERIVED**: `stage_age_days` (from `stage_entered_at`), `days_to_close` (from `expected_close_date`), `is_over_sla` (from stage SLA config). All computed; **DERIVED** only.

### `useDealDetail` (verify exists / extend) — Track A-core
Currently `useDeals(id)` may be the path; if a dedicated detail hook doesn't exist, build one. Needs:
- `stage_history[]` — verify `deal_stage_log` table exists; if so, **READY** with extension. If not, **SCHEMA GAP** for stage log table.
- `bid_board_owned` — **DERIVED** (`stage.position >= estimating.position`).
- `estimate_line_items[]` — after A2, **HOOK GAP**.
- `party_grid` — primary contact + assigned rep, both already FK'd. **READY**.
- Bid Board mirror fields — already on `deals` schema. **READY**.

### `useLeadBoard` — Track A-core (verify only)
Canonical stages match. Drop legacy `opportunity` lead stage from view layer (Track D handles in page code, not a hook change). **READY**.

### `useLeads` — Track A-core (verify only)
`estimated_value`, `source`, `source_category` already present. **READY**.

### `useEmails` — extend after A3 (Track A-core)
Add: `linked_records[]` from `email_links` junction (replaces single-FK consumption); `ai_suggestions` array; thread grouping via existing `graphConversationId` (column name `graph_conversation_id`, exposed by `useEmails` / `useEmailThread` today); per-row `status` (linked / low_confidence / unassigned / sent — **DERIVED** from confidence + assignments). **HOOK GAP**.

### `useFiles` — extend after A3 (Track A-core)
Add: `linked_records[]` from `file_links` junction; `is_starred` for current user (from `user_starred_files`); `kind` from existing `category` enum (already present, ensure mapping). **HOOK GAP**.

### `useTasks` — Track A-core (verify only)
`type`, `priority`, `due_date`, `status`, linked entity all present — **READY**.

### `useReports` — rebuild after A4 (Track A-isolated)
Currently a placeholder. Rebuild to return:
- `reports[]` from `reports` table joined with user pin state
- `schedules[]` from `report_schedules`
- `recent_runs[]` from `report_runs` with runtime stats
- `pinned[]` and `my_reports[]` per current user
- mutations: `runReport(id)` (creates a `report_runs` row, returns id), `scheduleReport(...)`, `pinReport(id)` / `unpinReport(id)` (uses user prefs jsonb or new `user_pinned_reports` pivot — choice deferred to A4 implementation; recommend pivot)
**HOOK GAP** + likely small SCHEMA GAP for `user_pinned_reports` (decide in A4).

### `useDirectorDashboard` — extend after A5a / A5b (Track A-isolated)
Add:
- `forecast_vs_goal` — period total + goal + delta + weeks remaining (**DERIVED** from `rep_performance_snapshots` aggregates + a `goals` config — verify `goals` table exists; if not, may need a goals table or env config).
- `at_risk_deals[]` — already partially in `useRepDashboard.downstreamBottlenecks`; expose at director level (**HOOK GAP**).
- `strategic_alerts[]` — **DERIVED** (rules engine reading bottlenecks + win-rate drop + activity dip; rules defined in A5).
- `ai_coaching_prompts[]` — **DERIVED** (rule-based seed: high pipeline + low win rate → "review forecast"; etc. Real AI integration is post-rollout).
- `activity_pulse[]` — per-rep weekly counts from `rep_performance_snapshots` (**HOOK GAP**).
- `recent_closes[]` — from `deals` where `outcome_category` in won/lost in last N days (**HOOK GAP**).

### `useRepPerformance` — rewrite after A5a (Track A-isolated)
Returns per-rep row from `rep_performance_snapshots`: `closed`, `pipeline + count`, `distribution`, `win_rate` + trend delta, `at_risk_count`, `activity dot`, `sparkline_8w[]`. **HOOK GAP**.

### `useCommissionBreakdown` — NEW (Track A-core, small follow-up after A1)
Returns per-deal commission with stage grouping; delta indicators (commission diff vs prior snapshot — needs a `commission_snapshots` table OR computed against last close). Commissions My-view in `/commissions`. **HOOK GAP** + possible small **SCHEMA GAP** for delta source-of-truth (TBD: snapshot table vs change-log on deal value).

### `useActivities` — Track A-core (verify only)
`type`, `subject`, `body`, `occurred_at`, `rep_id`, polymorphic entity all present — **READY**.

### `usePipelineStages` (existing `use-pipeline-config.ts`) — Track A-core (verify only)
Returns stages with position, color, SLA. Used by deal-detail pipeline-progress card. **READY**.

---

## §3 Server-side derivations (DERIVED — no migration needed)

Track A writes the query/aggregate; the server returns these computed values:

- `companies.properties_count`, `contacts_count`, `active_deals_count`, `pipeline_value` — aggregate joins.
- `properties.engagement_status`, `linked_value`, `photos_count`, `active_pipeline_value` — joins on deals/leads/files.
- `contacts.linked_deals_count`, `last_touch_at` — max across activities/emails/tasks.
- `deal.stage_age_days`, `days_to_close`, `is_over_sla` — date math + stage SLA lookup.
- `deal.bid_board_owned` — boolean: `stage.position >= estimating.position`.
- `companies.last_activity_at` / `properties.last_activity_at` — Track A picks: column with trigger (preferred for query speed) vs view aggregating from activities. **SCHEMA GAP** on the column path; pure DERIVED on the view path. Decide in A1 — recommend column with trigger.
- `/director strategic_alerts` — heuristic from bottlenecks + win-rate trend. Rules defined in A5 PR description.
- `/director ai_coaching_prompts` — initial seed: rule-based on activity volume + win rate + at-risk count. Real AI integration is post-rollout.
- `/reports` recent runtime stats — aggregate from `report_runs`.
- Email `status` pill (linked/low_confidence/unassigned/sent) — DERIVED from `email_links` count + `assignment_confidence` thresholds.

---

## §4 Per-page consumption map (verification cross-reference)

For each page, the field set that lights up the gap above. Track A uses §1 + §2 as the work order; §4 is for verification that each page's needs are covered.

### `/` Rep Dashboard
All from `useRepDashboard` — **READY** (after the `fetchedAt` extension that already landed).

### `/director` Director Dashboard
- Forecast vs Goal block — `useDirectorDashboard.forecast_vs_goal` — HOOK GAP (A5a).
- Sales Force Performance table — `useRepPerformance` — HOOK GAP (A5a).
- At-Risk Deals card — `useDirectorDashboard.at_risk_deals` — HOOK GAP (A5a; partial overlap with `useRepDashboard.downstreamBottlenecks`).
- Strategic Alerts panel — `useDirectorDashboard.strategic_alerts` — DERIVED (A5a).
- AI Coaching panel — `useDirectorDashboard.ai_coaching_prompts` — DERIVED (A5a).
- Activity Pulse — `useDirectorDashboard.activity_pulse` — HOOK GAP (A5a).
- Recent Closes — `useDirectorDashboard.recent_closes` — HOOK GAP (A5a).
- A5b refinement: rollup uses `companies.last_activity_at` / `properties.last_activity_at` for stale-account count per rep.

### `/deals`
- Board — `useDealBoard` — READY.
- Map view — uses `propertyLat` / `propertyLng` on deal cards — verify HOOK already returns these. If not, small HOOK GAP.
- Filter chips — stage list from `usePipelineStages` — READY.

### `/leads`
- Board — `useLeadBoard` — READY (drop legacy `opportunity` in view layer).
- Source chips — `useLeads` `source` / `source_category` — READY.

### `/companies`
- Industry filter chips — needs `industry` — SCHEMA GAP (A1).
- Table columns — see §2 `useCompanies` — HOOK GAP after A1 + DERIVED aggregates.

### `/contacts`
- Role filter chips — needs `role` — SCHEMA GAP (A1).
- Star icon — needs `is_primary` — SCHEMA GAP (A1).
- Linked deals count — DERIVED.

### `/properties`
- Type filter chips — needs `type` — SCHEMA GAP (A1).
- Sq ft column — `sqft` exists — READY.
- Engagement status pill — DERIVED.

### `/companies/:id`
- Hero industry/region/domain/HubSpot ID — SCHEMA GAP (A1).
- 9 tabs — Email tab needs `useEmails` (after A3); Recordings tab needs existing `useCallRecordings` + `topics` (after A3); Files tab needs `useFiles` (after A3).

### `/contacts/:id`
- Hero role / Primary pill — SCHEMA GAP (A1).
- LinkedIn / HubSpot ID sidebar — SCHEMA GAP (A1).
- 7 tabs — same comms/files pattern.

### `/properties/:id`
- Hero type / status pill — SCHEMA GAP (A1) + DERIVED status.
- Specs (sqft / floors / build_year) — `floors` SCHEMA GAP (A1); `sqft` + `build_year` READY.
- 7 tabs — same.

### `/deals/:id`
- Hero stage / days / value / account / property links — READY.
- Bid Board banner — `bidBoardOwned` DERIVED + existing mirror fields READY.
- Pipeline progress card — `usePipelineStages` + current stage from deal — READY.
- Bid Board summary card — existing mirror columns — READY.
- Estimate tab — `useEstimateLineItems` (after A2) — HOOK GAP.
- Photos tab — `useFiles` filtered to category in photo enum + deal_id — READY.
- Files tab (docs only) — `useFiles` filtered to non-photo category — READY.
- Stage history — `useDealStageHistory` (verify exists; if not, NEW HOOK GAP).
- Email / Recordings — same as other detail pages.

### `/email`
- Inbox list + detail — `useEmails` (after A3) — HOOK GAP.
- Status pill per row — DERIVED.
- AI suggestions in Assign popover — `emails.ai_suggestions` — SCHEMA GAP (A3).
- Multi-entity link chips — `email_links` junction — SCHEMA GAP (A3).

### `/tasks`
- All from `useTasks` — READY.

### `/files` page
- List — `useFiles` (after A3) — HOOK GAP.
- Multi-entity link chips — `file_links` junction — SCHEMA GAP (A3).
- Starred toggle — `user_starred_files` pivot — SCHEMA GAP (A3).

### `/reports`
- Library cards — `useReports` rebuild — HOOK GAP (A4).
- Scheduled tab — `useReports.schedules` — HOOK GAP (A4).
- Recent tab — `useReports.recent_runs` — HOOK GAP (A4).
- Pinned section — pivot or user-prefs JSONB — SCHEMA GAP (A4, decide in implementation).

### `/commissions`
- My view — `useRepDashboard.commissionSummary` returns floor/payments — READY.
- Stage breakdown loading bar — DERIVED from `commissionSummary` + per-stage aggregate.
- Projects contributing card — `useCommissionBreakdown` (NEW, A-core follow-up after A1) — HOOK GAP + possible small SCHEMA GAP for delta source-of-truth.
- Team view — `useRepPerformance` (after A5a) + per-rep commission summary aggregate — HOOK GAP.

---

## §5 Open questions for Track A to decide in PRs

These are explicitly punted to Track A's PR review rather than pre-decided here:

1. **`last_activity_at` column-vs-view**. Trigger-maintained column on `companies` / `properties` has best read perf but adds write paths. Aggregating view from `activities` is simpler but slower at scale. Recommend column-with-trigger for both. Track A confirms in A1 PR.
2. **Multi-entity linking style**. Junction tables (`email_links`, `file_links`) vs JSONB array on the parent. Recommend junctions — better indexing, cleaner referential integrity. Plan assumes junctions.
3. **`user_pinned_reports`**. Pivot table vs JSONB on a `user_preferences` table. Recommend pivot for query speed.
4. **`commission_snapshots` for delta indicators**. Snapshot table on schedule vs computing on the fly from a deal-value change-log. Defer to A-core's commissions follow-up; either is OK if the UI consumes a stable shape.
5. **Real reports execution**. A4 ships a stub. Real query execution worker is post-rollout. Track Z3 or a separate sprint owns this.
6. **`goals` table for forecast-vs-goal**. May need a small goals config table (per-rep, per-period). If it doesn't exist, A5a creates it or Z1.5 reveals the gap.
