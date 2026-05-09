# Track G1 Internal Review - Iteration 1

## Result

Changes requested, then applied in the same iteration.

## Findings

1. **Period mapping bug:** `useRepPerformance` originally mapped every non-MTD/QTD preset to `"year"`, so Last month and Last quarter would show the wrong closed-performance support data. Fixed by mapping `last_month -> month`, `last_quarter -> quarter`, and `last_year -> year`.

2. **Activity pulse bar math:** stacked activity segment widths were being scaled twice by the row width, making the distribution visually under-represented. Fixed by letting the outer row bar carry the total-width scaling and each inner segment use its share of the row total.

## Spec Check

- Header: matches requested title, freshness line, period tabs, refresh, bell/action icons, avatar.
- KPI strip: exactly three cards.
- Forecast vs goal: present with actual/target, gap caption, mini metrics, and two progress bars.
- Sales force table: requested columns and semantic rep drilldown links are present.
- Strategic alerts: dark right panel using real `strategicAlerts`.
- At-risk deals: left table with deal detail links and SLA badge. Company name is not shown because the current hook payload does not include it.
- AI coaching: right panel using real `aiCoachingPrompts`.
- Activity pulse: left panel sorted by total activity.
- Recent closes: right panel using real `recentCloses`.

## Data Integrity Check

No fake numeric director data introduced. All values come from existing hook fields or are deterministic calculations from those fields.

## Accessibility Check

Navigation uses native `Link`; no `Button render={<Link>}` pattern is present. Refresh and action icon buttons have labels/titles.
