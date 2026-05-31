# F1 period helper — reconciliation against existing period math (FLAGS)

F1 (`server/src/lib/period.ts`, `getWtdPeriod`) is the single canonical Sunday–Saturday week
definition, business-tz (America/Chicago) anchored, with two end-modes (`to_date` = live dashboard
week-to-date; `completed` = prior Sun–Sat box for the Monday reports). Per the locked spec, F1 targets
the **canonical** Sun–Sat definition and the rest of the platform aligns to it — not the reverse.
Below is what F1 matches and what it deliberately DIVERGES from (flagged, not silently matched).

## ✅ Matches (by design)
- **#539 client WTD** — `client/src/lib/pipeline-terminal-filters.ts:161-164`
  (`toDatePresetRange("wtd")`: walk back to most-recent Sunday via `getDay()`, run to today). This is
  the definition the platform standardized on; F1 reproduces its Sunday anchoring exactly. Proven by
  the full-week reconciliation sweep in `server/tests/lib/period.test.ts`.

## ⚠️ Diverges from (FLAGGED — these should later align to F1, not F1 to them)
1. **Rep-dashboard "week" activity = ROLLING 7-DAY window**, not weekday-anchored —
   `server/src/modules/dashboard/service.ts:~1405-1410` (anchors to CT midnight 7 days ago). A "this
   week" report built on F1 (Sun–Sat) will NOT equal this rolling-7 surface for the same label.
2. **Reports module "week" grouping = MONDAY-ISO** — `server/src/modules/reports/report-builder-service.ts:110`
   (`TO_CHAR(DATE_TRUNC('week', …), 'IYYY-IW')`; Postgres `date_trunc('week')` is Monday-based). F1's
   `sundayWeekBucketSql` is the Sunday-anchored replacement; the trend surfaces must use it, not :110.
3. **Worker rep-performance snapshots = UTC-anchored** period boundaries —
   `worker/src/jobs/rep-performance-rollup.ts:80-106` (mtd/qtd/ytd/last_month via `getUTC*`; `week_8back`
   = today − 55 days, a rolling ~8-week window, not calendar-aligned). Different anchor AND tz from F1.

## Why the protected Won number is unaffected
The canonical Won aggregate (`getWonCloseSummary`, `dashboard/service.ts:2264`) is scoped by an explicit
`won_closed_date {from,to}` range — NOT by any week anchor. F1's week definition only governs how
"this week" Sent/Estimated/Won-this-week surfaces are scoped; it does not move the protected
191 / $9,778,045.90. Reports pass F1's `{from,to}` into the SAME `getWonCloseSummary`, so a report and
the dashboard reading the same period are identical by construction.

## Net
No silent matching to a wrong definition. F1 == #539 canonical Sun–Sat WTD. The three divergent surfaces
are recorded here as alignment targets for the reports suite (use F1 / `sundayWeekBucketSql`; do not
reuse the Monday-ISO bucket or the rolling-7 window for the new "this week" reports).
