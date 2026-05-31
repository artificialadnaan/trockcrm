# Reports Rebuild -- Discovery + Plan (READ-ONLY)

Status: DISCOVERY COMPLETE. Parked for review. Branch: disco/reports-rebuild (off main @ 8d2f81a3).
Tenant probed: prod office_dallas (read-only, default_transaction_read_only=on). Date: 2026-05-30.
Build nothing -- this is discovery + plan; awaiting greenlight + the current reporting samples.

Artifacts in this commit:
  - .audit/reports-rebuild-discovery.md       (THIS FILE -- executive synthesis + plan)
  - .audit/reports-rebuild-workflow-map.md     (full per-endpoint inventory + metric map + week/date
                                               + projections/collections + completeness critique;
                                               produced by a 10-agent read-only workflow)

How this was produced: inline code scout -> 10-agent read-only mapping workflow (every reporting
surface + a metric->canonical-source consistency pass + week/date + feasibility + a completeness
critic) -> read-only prod data-shape probe (Section 3). All file:line citations are in the
workflow-map; this file summarizes and plans.

================================================================================
## 0. THE BUSINESS NEED (restated)

A) Weekly PER-DEPARTMENT rollup, "this week" = Sunday-anchored WTD (PR #539):
   amount ESTIMATED / SENT TO CLIENT / WON / COLLECTED this week.
B) PER-REP sales report (Monday meeting): CLOSED; GOING-TO-CLOSE (projected 30/60/90);
   SENT TO CLIENT per rep (same source the rep already sees); WHERE active leads are.

================================================================================
## 1. CURRENT-STATE INVENTORY (summary; full per-endpoint detail in workflow-map.md sec A)

A large TIERED reporting system already exists (~30 surfaces). It is NOT empty -- the risk is
consistency, not absence.

  Tier 1 "Sales"        (reports/sales-tier1-service.ts): pipeline-velocity, closed-won-revenue,
                         lead-conversion
  Shared service.ts     pipeline-summary, weighted-forecast, win-loss, win-rate-trend,
                         pipeline-by-rep, rep-performance, regional-ownership, workflow-overview,
                         stale-deals, lost-by-reason, follow-up-compliance, revenue-by-type,
                         lead-source-roi, forecast-variance, data-mining, opportunity-vs-pipeline
  Tier 2 "Performance"  (performance-tier2-service.ts): director-scorecard, rep-activity,
                         forecast-accuracy
  Tier 3/4 "Ops/Analytics" (operations-tier3 / analytics-tier4): market-mix, customer-concentration,
                         executive-trends, workflow-bottlenecks, project-readiness, portfolio-load
  Forecast/builder      forecast-milestones-service.ts, report-builder-service.ts (ad-hoc + saved +
                         scheduled runs), saved-reports-service.ts
  Dashboard (canonical display) dashboard/service.ts: getWonCloseSummary (the protected Won basis),
                         Closed/Won cards, per-rep getCanonicalRepWonSummary, rep-dashboard-page.tsx
  Commissions (separate aggregator) commissions/reporting-service.ts: ONLY reader of the
                         deal_payment_events (collections) ledger; rep/team-commissions-page.tsx
  Client                client/src/pages/reports/* (tier nav reports-page.tsx), report-filter-bar.tsx

Gating: requireDirector = win-loss, pipeline-by-rep, rep-performance, regional-ownership,
director-scorecard, forecast-accuracy, revenue-by-type, lead-source-roi, forecast-variance,
data-mining, workflow-bottlenecks, project-readiness, portfolio-load. Rep-visible (auto-scoped to
self) = pipeline-velocity, closed-won-revenue, lead-conversion, pipeline-summary, weighted-forecast,
win-rate-trend, workflow-overview, stale-deals, rep-activity. (lost-by-reason / opportunity-vs-pipeline
have NO rep scoping -- any role sees org-wide; flagged.)

================================================================================
## 2. THE CRITICAL FINDING -- metric -> canonical source, and where reports DIVERGE

GOOD NEWS: the won/lost STAGE-SET membership is consistent everywhere (all 13+ reports import the
same WON_STAGE_SLUGS / LOST_STAGE_SLUGS / TERMINAL_STAGE_SLUGS from shared/src/types/workflow.ts via
shared/pipeline-terminal-stages.ts). So "which stages count as won" is NOT the problem.

THE PROBLEM is three systemic axes of divergence -- reports DO scrape different datasets than the
platform shows. Canonical source per metric, then the divergences:

WON  -- canonical: getWonCloseSummary (dashboard/service.ts:2238). Triad = value
  aliasedEffectiveWonDealValueSql (AWARDED-first chain), period gated on deals.won_closed_date
  (deals/service.ts:980; app-owned, set by changeDealStage on Won entry, cleared on reopen/Lost;
  migration 0141), stage in WON_STAGE_SLUGS, with !test + !on_hold. Same triad backs the Closed card,
  the per-rep getCanonicalRepWonSummary, the pipeline Won column, and /deals?filter=won.
  DIVERGENCES (the "different dataset" risk -- all real):
    - sales-tier1 closed-won-revenue keys Won off a SYNTHETIC date
      COALESCE(contract_signed_at, actual_close_date, stage_entered_at, updated_at) -- NOT
      won_closed_date; the updated_at fallback drags arbitrary edits into the Won period
      (sales-tier1-service.ts:133-141).
    - analytics-tier4 won-trend keys Won off deal_stage_history.created_at (transition LOG time) +
      fallback actual_close_date/updated_at -- a 3rd date basis AND a different population (a
      reopened+re-closed deal is counted multiple times) (analytics-tier4-service.ts:648,659).
    - report-builder CANNOT key Won off won_closed_date at all -- its date-field enum lacks the
      column (report-builder-service.ts:34-40); closest is the contaminated actual_close_date.
    - forecast-variance defines "won" by EXISTENCE of a deal_forecast_milestones row
      (milestone_key='closed_won') and uses that row's awarded_amount -- never consults stage slug,
      won_closed_date, or the deal value chain. The single most likely report to disagree with
      every other Won surface (service.ts:387-538).
  => A "Won" total or weekly Won trend in these reports will NOT reconcile to the dashboard Won card.

VALUE BASIS  -- THREE coexisting value chains (shared/deal-value-sql.ts), so the SAME deal yields
  different dollars across reports:
    (1) best-estimate OPEN: bid_board_total_sales -> bid_estimate -> dd_estimate -> awarded_amount
        (aliasedEffectiveDealValueSql) -- pipeline-summary, pipeline-by-rep, director-scorecard,
        regional-ownership, weighted-forecast.
    (2) forecast-FIRST: forecast_revenue -> ... -> awarded_amount (aliasedForecastFirstDealValueSql)
        -- pipeline-velocity open value, forecast-accuracy forecastValue. (forecast_revenue is
        write-dead in prod, so this currently falls through to the same tail -- but the code path
        differs and would diverge the moment forecast_revenue is populated.)
    (3) awarded-FIRST WON: awarded_amount -> bid_board_total_sales -> bid_estimate -> dd_estimate
        (aliasedEffectiveWonDealValueSql) -- all "won revenue" figures.
  All zero out value when on_hold. Net: open-pipeline $ in pipeline-velocity/forecast-accuracy can
  exceed pipeline-summary/director-scorecard for the SAME deals.

SENT TO CLIENT  -- canonical is STAGE-based: stages estimate_sent_to_client /
  service_estimate_sent_to_client. The timestamp deals.proposal_sent_at is EMPTY in prod and unused
  by reporting (Section 3). "Sent this week" = transitions INTO the sent stage in deal_stage_history.
  FORECAST-WEIGHT CONFLICT for a sent-to-client deal across 3 surfaces:
    - director-scorecard forecastCommit treats estimate_sent_to_client as COMMIT = 100%
      (COMMIT_STAGE_SLUGS, performance-tier2-service.ts:18).
    - forecast-accuracy weights the SAME slug at 0.50 (the stage ladder, performance-tier2:832).
    - weighted-forecast ignores stage entirely, using per-deal win_probability (default 50),
      service.ts:668.
  => three forecast surfaces assign three different probabilities to the same deal.

ESTIMATED  -- "amount estimated this week" is best modeled as transitions INTO an estimating stage in
  deal_stage_history (proven feasible, Section 3), valued by the platform value precedence. (No
  dedicated estimate-sent date column; estimating is a stage, like sent.)

COLLECTED  -- canonical source IS in-system: deal_payment_events.paid_at + gross_revenue_amount
  (minus credit memos); only reader today is commissions (reporting-service.ts:147). BUT the ledger
  is EMPTY and has NO WRITER anywhere in the codebase (Section 5) -> no data exists yet.

CLOSED (per rep)  -- = Won; canonical per-rep source is getCanonicalRepWonSummary (same won_closed_date
  triad). Report B must use this, not a hand-rolled query.

PROJECTED / GOING-TO-CLOSE (30/60/90)  -- inputs: expected_close_date + win_probability. The dedicated
  forecast block (forecast_revenue/category/window/confidence) is WRITE-DEAD (Section 5). Not reliable
  today (Section 3): expected_close_date is stale.

SENT-PER-REP / LEAD-STATUS  -- sent-per-rep = same stage source sliced by assigned_rep_id; lead-status
  = lead pipeline by stage. (Detail in workflow-map sec B.)

OTHER STRUCTURAL DIVERGENCES (workflow-map sec A/C):
  - OFFICE attribution differs: regional-ownership + lead-source-roi + data-mining scope office via
    deal_scoping_intake.office_id (and DROP deals lacking an intake row); every other report uses
    users.office_id or deals.office_code. The dsi-based reports under-count.
  - Several reports accept from/to but IGNORE them (pipeline-summary, workflow-overview) -> the
    FilterBar date range has zero effect.
  - report-builder weekly bucket is MONDAY-based ISO week ('IYYY-IW', report-builder-service.ts:110)
    -- contradicts the Sunday WTD (Section 4).

================================================================================
## 3. PROD DATA-SHAPE / FEASIBILITY (READ-ONLY; office_dallas is the ONLY live tenant)

office_atlanta + office_pwauditoffice exist but have 0 deals. Numbers below = office_dallas.

Deals: 1205 total, 1122 active, 15 reps. assigned_rep_id populated 1195/1202 (99.4%).

WON basis -- protected 191/$9,778,045.90 is a SCOPED figure; could NOT be reproduced naively:
  stage{closed_won,won}+won_closed_date+!test+!on_hold (all-time) = 277 / $19,398,172.99
  won_closed_date NOT NULL (naive)                                = 318 / $32,833,037.35
  currently in a won stage (no filters)                           = 350 / $36,690,521.43
  => 191/$9.78M is narrower still (getWonCloseSummary's period window). CONFIRMS reports MUST call
     getWonCloseSummary; a hand-rolled Won diverges by MILLIONS. (Won slugs: closed_won, won.)

"THIS WEEK" estimated/sent/won  -- feasible from deal_stage_history (the #535 forward-recording
  backstop): 567 rows, 2025-12-11..2026-05-30, to_stage_id+created_at. Weekly Sun-Sat counts:
     week 2026-05-24: est=32 sent=14 won=13 (all=89)
     week 2026-05-17: est=39 sent=50 won=45 (all=370)  <-- BACKFILL spike, NOT organic
     week 2026-05-10: est=36 sent=25 won=7  (all=74)
     week 2026-05-03: est=7  sent=1  won=0  (all=19);  earlier ~0 (history thin pre-backstop)
  CAVEAT: early weeks unreliable (backstop recently deployed; 05-17 has a bulk artifact).

SENT TO CLIENT -- stage-based (proposal_sent_at = 0 populated). 258 deals currently in the sent stage.

COLLECTED -- deal_payment_events EMPTY in all schemas (0 rows). No collected data exists.

PROJECTIONS 30/60/90 -- NOT reliable: 319 open deals; 235 have expected_close_date but only 15 are
  FUTURE-dated (30d=12, 60d=14, 90d=14); forecast_revenue/category = 0 populated. -> stale + dormant.

DEPARTMENT grouping -- SPARSE/ambiguous: office_code dfw-dominant, atl=1, NULL=789/1205;
  region_id 3 values (620 / 114 / 15; ~38% NULL); no region lookup table in tenant.

PER-REP -- fully feasible: assigned_rep_id 99.4% populated, 15 reps.

================================================================================
## 4. WEEK / DATE MODEL (workflow-map sec C)

CORRECTION to my earlier note: PR #539 IS MERGED into main (commit ccf66bfc, 2026-05-30).
  CANONICAL WTD util EXISTS: client/src/lib/pipeline-terminal-filters.ts:135 toDatePresetRange("wtd")
  -- Sunday-anchored, user-LOCAL calendar, week-to-DATE (from=most-recent Sunday, to=today).
  Reports MUST consume this; do not add a 5th copy. (It is computed in 4 places today; only
  director-rep-detail.tsx imports the canonical; deal-list-page + pipeline-stage-page inline
  Sunday-correct duplicates; use-director-dashboard.ts presetToDateRange LACKS wtd entirely -- the
  director-dashboard surface, where rebuilt reports likely sit, cannot select WTD yet.)
Canonical Won-date util to consume (server): aliasedWonHsClosedWonDateSql (deals/service.ts:970).
Two NON-Sunday week definitions to fix/avoid: report-builder ISO Monday week (:110, CRITICAL); and
  dashboard activity "week" = rolling 7-day (service.ts:1381-1388).
GREY's platform-wide canonical DATE model is not yet a symbol in code; the seams it plugs into:
  (1) client week util toDatePresetRange; (2) a server Sunday weekBucketSql() replacing the ISO bucket;
  (3) a per-metric metricDateSql() registry so Won keys off won_closed_date everywhere; (4) the
  from/to filter transport. Reports CONSUME these -- coordinate, don't invent.

================================================================================
## 5. PROJECTIONS + COLLECTIONS FEASIBILITY (workflow-map sec D)

PROJECTIONS: data partially exists but is unreliable. The dedicated forecast block on deals
  (forecast_revenue/category/window/confidence) is WRITE-DEAD -- nothing in the codebase writes it,
  0 populated in prod. Only forward inputs reliably writable are expected_close_date + win_probability
  (exposed in deal-form.tsx), both sparse + unenforced (Section 3: only ~15 open deals future-dated).
  => A reliable per-rep 30/60/90 needs EITHER data-hygiene enforcement of expected_close_date, OR a
     stage-probability model (stage x historical velocity x win-rate from deal_stage_history), OR
     activating the forecast block. Recommend the stage-probability model as the reliable default.

COLLECTIONS: deal_payment_events exists (gross_revenue_amount, gross_margin_amount, paid_at,
  is_credit_memo, recorded_by_user_id) and commissions reads it -- but it has ZERO rows and NO WRITER
  anywhere (no UI, no integration writes it). => "Collected this week" cannot show real numbers until
  a data source exists: a manual record-payment workflow OR a finance/accounting integration.

================================================================================
## 6. REBUILD PLAN (proposal -- for review; build nothing yet)

GUARANTEEING REPORTS MATCH THE PLATFORM (the core requirement): every metric calls the SAME canonical
function/column the platform already shows -- never a parallel query. Concretely:
  - Won / Closed  -> getWonCloseSummary / getCanonicalRepWonSummary verbatim (won_closed_date triad).
                     Delete the report-side synthetic won-date COALESCEs; do not re-derive Won.
  - Value         -> ONE value-chain helper per context (open vs won); remove the forecast-first vs
                     best-estimate split for open pipeline.
  - Sent / Estimated "this week" -> deal_stage_history transitions into the canonical stage sets,
                     valued by the platform value precedence, bucketed by the #539 Sunday WTD util.
  - Collected     -> deal_payment_events.paid_at; BUT gate behind a data-source decision (empty today).
  - Projected     -> a stage-probability model over open deals (recommended) since forecast fields are
                     write-dead and expected_close_date is stale.
  - Per-rep       -> getCanonicalRepWonSummary + the rep's own sent/lead sources, sliced by
                     assigned_rep_id (well populated).
  - Week/date     -> consume #539 toDatePresetRange("wtd") + a new Sunday weekBucketSql(); fix the
                     report-builder Monday ISO-week; key every metric's period off its canonical date
                     column (Won->won_closed_date, collected->paid_at, sent/estimated->stage-history
                     created_at, projected->expected_close_date).

REPORT A (weekly per-department): one query over deal_stage_history (transitions in the WTD window)
  bucketed Sun-Sat, grouped by the chosen department key, columns estimated/sent/won; collected joined
  from deal_payment_events.paid_at (pending data). Won column reconciled to getWonCloseSummary.

REPORT B (per-rep Monday): closed = getCanonicalRepWonSummary(rep); sent = stage source sliced by rep;
  lead-status = lead pipeline by stage for the rep's leads; going-to-close = stage-probability model.

================================================================================
## 7. OPEN DECISIONS FOR THE USER (resolve before build)

  1. "DEPARTMENT" definition: functional/pipeline (estimating->sent->won->collected, fits the data +
     deal_stage_history) vs geographic office/region (office_code is mostly dfw/NULL; region_id 3
     values ~62% populated). The 4 metrics read as a funnel, suggesting functional -- CONFIRM.
  2. COLLECTED data source: finance/accounting integration vs a manual record-payment workflow vs
     defer the Collected column. (Ledger + reader exist; data + writer do not.)
  3. PROJECTION method: stage-probability model (recommended) vs enforce expected_close_date hygiene
     vs activate the dormant forecast block.
  4. Scope of consolidation: rebuild as a thin canonical-sourced layer that REPLACES the divergent
     report queries, or build the 2 new reports (A,B) first and remediate the existing ~30 surfaces'
     divergences as a follow-up. (Recommend: build A+B on canonical sources; track the existing-report
     divergences -- Section 2 -- as a separate consistency-remediation epic.)
  5. Confirm reports CONSUME GREY's date model + #539 WTD once finalized (sequencing/coordination).

================================================================================
## 8. RESUME / NEXT (when greenlit)
  - Get the current reporting SAMPLES the team uses (user will send) -> map each sample metric to its
    canonical source via Section 2 / workflow-map sec B; flag any sample that diverges.
  - Resolve the 5 open decisions (Section 7).
  - Then (separate task, on approval) build Report A + Report B on canonical sources. Build nothing now.

================================================================================
## 9. POST-DECISION INVESTIGATION (2026-05-30) -- decisions resolved + projection hygiene + date seam

DECISIONS (from product owner):
  1. DEPARTMENT = functional pipeline NOW (estimating->sent->won->collected); architect so a
     geographic office/region cut can be layered in later.
  2. COLLECTED = DEFERRED. Build estimated/sent/won this week now; render Collected as a clearly
     marked placeholder (NOT a zero-filled column), wired later when the finance source is decided.
  3. PROJECTION = read deals.expected_close_date (per below), and report the hygiene gap.

PROJECTION HYGIENE -- expected_close_date is POPULATED BUT NOT MAINTAINED (prod office_dallas, open deals):
  - Populated 73.7% (235/319). BUT 94% of those are PAST-dated (220/235). Only 15 of 319 open deals
    (4.7%) are FUTURE-dated: 30d=12, 30-60d=2, 60-90d=0, >90d=1.
  - Not maintained: 188 deals edited >30d AFTER the date already passed (touched, not updated);
    220 stale-dated deals were active in the last 30 days. Systemic across reps (top reps by volume
    have ~0-7 future-dated of 40-83 open).
  => Reading expected_close_date today yields a ~14-deal projection across the whole 90-day horizon
     -- effectively empty. The projection will be hollow until the INPUT side is fixed.

INPUT-PATH AUDIT (why it is stale):
  - Editable <input type=date> on create AND edit (deal-form.tsx:564-573), but OPTIONAL, unmarked,
    buried last in the Deal Information card; only a non-blocking "in the past" warning (:195-206).
  - Lead->deal CONVERSION (the primary create path) neither prompts nor inherits it
    (lead-convert-dialog.tsx:32; leads table has no such column) -> converted deals start NULL.
  - STAGE-CHANGE ignores it entirely (stage-change.ts never reads/sets/prompts expected_close_date)
    -- the single most natural maintenance moment does nothing.
  - The "missing field" nudge (post-conversion-enrichment.ts) is computed but NO client consumes it;
    the rep-facing cleanup queue omits expected_close_date entirely.
  - Provenance: current values are HubSpot import-origin (refresh-from-hubspot.ts maps closedate ->
    expected_close_date) and that script OVERWRITES rep edits on a real run (proposes a change
    whenever CRM != HubSpot, :326-335) -- though it is dry-run-by-default + manual, not on cron.
  - A config lever EXISTS but is not active: pipeline_stage_config.required_fields + stage-gate
    machinery (stage-gate.ts:299-306) + a registered label (:74) can REQUIRE expected_close_date to
    enter a stage; no migration/seed activates it.

INPUT-SIDE FIX OPTIONS (leverage order; for the owner to decide -- build nothing yet):
  1. Require via STAGE GATE at a chosen stage (LOWEST effort -- machinery + label already exist;
     add "expected_close_date" to that stage's required_fields config/seed).
  2. Prompt/require on STAGE-CHANGE (highest leverage; needs StageChangeInput + stage UI changes).
  3. Prompt on CONVERSION (add a field to lead-convert-dialog; service already accepts it).
  4. Surface the existing enrichment nudge / add an expected_close_date reason to the cleanup queue.
  5. Make the HubSpot sync null-only-fill so it cannot clobber rep edits (else 1-4 are undermined).
  RECOMMENDATION: at minimum (1) or (2), plus (5); otherwise the field stays set-once and goes stale.

CANONICAL DATE SEAM ("buildDealOutcomeDateScope") -- coordination note:
  - buildDealOutcomeDateScope does NOT exist in code (GREY's planned/aspirational symbol; confirmed
    not a symbol anywhere). Do not wait on it to build.
  - The REAL canonical seam TODAY is per-metric:
      WON  -> aliasedWonHsClosedWonDateSql (deals/service.ts:970) = won_closed_date, consumed by
              getWonCloseSummary (dashboard/service.ts:2238) + getCanonicalRepWonSummary (:2287).
              Reports call THESE; never re-derive Won.
      SENT/ESTIMATED -> no helper; key off deal_stage_history.created_at transitions into the target
              stage slugs (reference join: analytics-tier4-service.ts:647-656). ESTIMATED has no true
              event-date column (WEAK) -- the only dated proxy is stage-entry into an estimating stage.
      PROJECTED -> deals.expected_close_date ALONE (no COALESCE fallback; the perf-tier2 monthly join
              COALESCE at :871 contaminates -- do not copy it).
  - When GREY's buildDealOutcomeDateScope lands it should WRAP these (a {from,to,column} bundle per
    outcome) and for WON MUST delegate to aliasedWonHsClosedWonDateSql (resolve to won_closed_date),
    not redefine the column. Plan: build on the existing per-metric seams now; swap to GREY's bundle
    when it lands (1-line change at the date-scope call site).
