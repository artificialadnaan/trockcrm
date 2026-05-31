# Reports Rebuild -- Part 2 Variant PLAN (for review; NO build until approved)

Status: PLAN. Designed from discovery (no samples needed). Awaiting owner approval -> then build.
Additive: every variant ships ALONGSIDE existing reports (a Monday showcase the team votes on); none
replaces an existing report. Many presentations, ONE source of truth.

================================================================================
## 1. THE SINGLE SOURCE-OF-TRUTH MAP (identical for EVERY variant)

| Metric | Canonical source | Date key | Notes |
|---|---|---|---|
| WON / CLOSED (aggregate) | getWonCloseSummary (dashboard/service.ts:2238) | won_closed_date | NEVER re-derived; ties to 191 / $9,778,045.90 |
| CLOSED per-rep | getCanonicalRepWonSummary (:2287) | won_closed_date | SUM(per-rep) == aggregate by construction |
| SENT this week | deal_stage_history INTO estimate_sent_to_client / service_estimate_sent_to_client | dsh.created_at | value = platform precedence |
| ESTIMATED this week | deal_stage_history INTO estimating / service_estimating | dsh.created_at | WEAK (stage-entry proxy; no event-date column) |
| PROJECTED 30/60/90 | deals.expected_close_date ALONE (no COALESCE) | expected_close_date | sparse -> caveat MANDATORY |
| LEAD-STATUS | rep's active leads grouped by lead pipeline stage | n/a (current-state) | point-in-time, no date bucket |
| COLLECTED | deal_payment_events.paid_at + gross_revenue_amount | (deferred) | placeholder, NEVER zero-filled |

"This week" = Sunday-Saturday WTD (#539, toDatePresetRange("wtd")). Do NOT adopt buildDealOutcomeDateScope
yet (BLUE's P0 repoints its wonDate to won_closed_date; until then WON stays on aliasedWonHsClosedWonDateSql).

================================================================================
## 2. PROJECTION-COVERAGE CAVEAT (mandatory wherever a projection appears)

Literal honesty note: "N of M open deals have a maintained (future-dated) expected close date."
  - M = ALL open non-terminal deals (INCLUDING Bid-Board-mirror deals that carry a NULL
    expected_close_date -- they land in the not-covered denominator, never silently dropped).
  - N = those with a future-dated expected_close_date.
  - Prod reality: only ~15 of ~319 open deals are future-dated -> the 30/60/90 WILL look sparse; the
    caveat keeps it honest (never a bare number that looks broken). Per-rep N/M sums to the office N/M.

================================================================================
## 3. SHARED FOUNDATIONS (build ONCE; all variants depend on these so no two EVER disagree)

F1. Server Sunday weekBucketSql -- NET-NEW (confirmed: none exists; report-builder uses Monday ISO week).
    The ONE Sunday-anchored bucket matching toDatePresetRange("wtd") (filters.ts:146). Every "this week"
    / weekly surface uses it. (Hard precondition for the whole suite.)
F2. Shared N/M coverage helper -- ONE office-wide computation of the projection denominator; per-rep
    splits MUST sum to it (so the banner, the chips, and the ladders never drift).
F3. Value-label discipline -- Won $ = awarded-first effective-won value (aliasedEffectiveWonDealValueSql);
    Sent/Estimated $ = platform precedence (awarded/bid_board_total_sales/bid_estimate/dd_estimate). These
    DIFFER by design -> never reconciled/summed across a funnel row or scoreboard. Each $ labeled with basis.
F4. Backfill rule -- the 2026-05-17 stage-history spike: EXCLUDED from any trend/average, flagged-but-shown
    in a raw single-week cell -- applied identically everywhere.
F5. Distinct-deal counting -- COUNT(distinct deal) per stage/week for Est/Sent (a deal re-entering a stage
    must not double-count) -- uniform everywhere.

================================================================================
## 4. REPORT A variants -- weekly per-department (functional pipeline), Sun-Sat WTD

A1. THROUGHPUT FUNNEL ("This Week's Flow") -- Estimated -> Sent -> Won as a left-to-right funnel; the
    gap between stages rendered as an explicit conversion/drop chevron ("sent 13, won 5, 8 in client
    hands"); Collected = greyed/hatched placeholder end. Best for: "where did this week's work get stuck."
    Honesty: the chevron is SAME-WEEK throughput, not a cohort conversion (Est/Sent are stage-entry
    cohorts, Won is a close-date cohort) -- labeled "this week," never implied as one deal-set flowing.
A2. DEPARTMENT SCOREBOARD (+ exec hero) -- one row/card per functional dept (Estimating / Sent / Won /
    [Collected placeholder]): this-week count + $, a WoW delta chip, an 8-week sparkline. Three hero
    numbers up top for the 5-second read. Best for: dept-by-dept pulse at a glance.
    [The standalone "Exec One-Glance" lens was folded in here as the hero row -- the critic found them
    near-duplicates. Can split back out as a hero-only tile if you want it separate for the vote.]
A3. MOMENTUM LANES (8-week trend) -- per dept, an 8-week Sun-Sat bar/slope lane with a delta vs the
    8-week average; the current partial week marked "in progress." Best for: DIRECTION (accelerating vs
    stalling), not just this week's snapshot.

================================================================================
## 5. REPORT B variants -- per-rep (Monday meeting)

B1. MONDAY ROLL-CALL SCORECARDS -- one card per rep: Closed headline (getCanonicalRepWonSummary), a
    30/60/90 projected ladder, Sent-this-week, and a mini lead-status pipeline -- identical four facts in
    four fixed spots. Best for: the rep-by-rep room walk.
B2. LEADERBOARD ("Monday Scoreboard") -- one sortable table; rank by Closed / Projected / Sent / active
    leads; TOTAL footer ties to the protected aggregate. Best for: competitive standings, live re-sort.
B3. REP LOAD LANE -- one horizontal funnel per rep: active leads (by stage) -> Sent -> Projected
    (30/60/90) -> Closed, with a per-lane N-of-M caption. Best for: "where is each rep loaded + what's
    coming."
B4. FORECAST LADDER (commit-by-date) -- per rep, Closed actuals + 30/60/90 commit rungs, each rung
    wearing its own "X of Y dated" confidence chip; office coverage banner. Best for: the forecast-meeting
    commit walk ("what are you committing to by when, and how solid are the dates").

(Report B is well-differentiated -- 4 genuinely distinct lenses; keep all four. Report A's spread is
tighter -- A2 absorbed the exec-glance to avoid a near-duplicate.)

================================================================================
## 6. BUILD APPROACH (after approval)

- Build F1-F5 (the shared foundations) FIRST -- they are the consistency guarantee.
- Each variant is a THIN presentation over the shared source helpers: getWonCloseSummary /
  getCanonicalRepWonSummary (Won), the dsh-WTD helper (Sent/Estimated), the expected_close_date
  projection helper + F2 caveat (Projected), lead-stage grouping (Lead-status).
- Additive routes/pages under /reports, alongside existing reports. Reconcile Won to the dashboard card
  during build (tie-out to the 191 / $9,778,045.90 scope).
- TDD the SOURCE HELPERS (the numbers) + a cross-variant reconciliation test (same period -> identical
  figure across every variant). The variants themselves are UI over verified helpers.

NEXT: your review/curation -- which variants make the Monday vote, and whether to split the exec-glance
back out of A2. Then I build the approved set. NO build until you greenlight.
