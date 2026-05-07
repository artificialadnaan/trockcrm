# A5a Validation Audit

## Period-Scoping Self-Check — 2026-05-07

Swept:
- `worker/src/jobs/rep-performance-rollup.ts`
- `server/src/modules/dashboard/service.ts`
- `client/src/hooks/use-rep-performance.ts`

Checked for `NOW()`, `CURRENT_TIMESTAMP`, `Date.now()`, `new Date()`, `getDate()`, and `getUTCDate()`.

Findings:
- `rep-performance-rollup.ts` has no remaining wall-clock comparisons for period-bounded snapshot metrics. `deals_count`, `pipeline_value`, `wins_count`, `losses_count`, `closed_value`, `avg_days_to_close`, `activity_*`, and `at_risk_count` all use the period parameters (`$2` / `$3`) where historical scope matters.
- The remaining `NOW()` in `rep-performance-rollup.ts` is `computed_at`, the snapshot write timestamp. It is intentionally wall-clock.
- `dashboard/service.ts` still uses `NOW()` for current-state operational surfaces (`getStaleLeadWatchlist`, `getDownstreamBottlenecks`, rep detail/current dashboard stale counts, admin health ages). These are not historical `rep_performance_snapshots` metrics and should represent the current CRM state.
- `dashboard/service.ts` uses `new Date()` / `Date.now()` for default current-year ranges, date parsing/fallbacks, and admin health labels. These are not period-bounded snapshot comparisons.
- `client/src/hooks/use-rep-performance.ts` has no wall-clock calls.

No additional period-scoping bug found in this sweep.
