# Reports 500 Regression — Production Smoke

Date: 2026-05-11
PR: [#245](https://github.com/artificialadnaan/trockcrm/pull/245)
Merge SHA: `32340748ba811372a74ff7706950342e2b153493`
Merged at: 2026-05-12T00:51:46Z

## Deploys

| Service | Status | Deploy ID | Commit |
|---|---|---|---|
| API | SUCCESS | `db1db135` | `32340748` |
| Frontend | SUCCESS | `783994cf` | `32340748` |
| Worker | DEPLOYING → (no impact for this fix) | `c298e171` | `32340748` |

Health check: `GET https://<prod-api-host>/api/health` → **HTTP 200**.

## Smoke account

`test-admin@trock.test` (admin role). Earlier tracks tried `test-admin` with the
shared smoke password and assumed the account was broken — the working
password for admin is the dev-mode local value (`<redacted — test creds in
ops vault>`). Admin role satisfies `requireDirector` for the Director
Scorecard endpoint.

## API smoke — all four endpoints (HTTP 200 with non-error bodies)

Run as `test-admin@trock.test` via `https://trockcrm.com/api/...` (matches the
`.trockcrm.com` cookie domain set by `/api/auth/local/login`).
Date window: `dateFrom=2026-02-10&dateTo=2026-05-11`.

### Pipeline Velocity — `GET /api/reports/pipeline-velocity`

- **HTTP 200**, 4160 bytes
- KPIs: `avgDealAgeDays=80`, `totalOpenValue=107,200,464.89`, `openDealCount=281`, `stuckDealCount=10`
- Stages array populated (first stage: Opportunity, 27 open, $4.73M, avg 20d)
- Body snippet:
```
  {"data":{"kpis":{"avgDealAgeDays":80,"totalOpenValue":107200464.89,
   "openDealCount":281,"stuckDealCount":10},"stages":[{"stageId":"03ab1b79-...",
   "stageName":"Opportunity","openDeals":27,...
```

### Closed Won Revenue — `GET /api/reports/closed-won-revenue`

- **HTTP 200**, 4778 bytes
- KPIs: `totalBookedRevenue=$7,240,115.39`, `wonDealCount=184`, `avgDealSize=$39,348`, `winRate=64.6%`
- Monthly revenue populated (Feb $807K / 40 won, Mar $3.4M / 79 won, Apr ...)
- Body snippet:
```
  {"data":{"kpis":{"totalBookedRevenue":7240115.39,"wonDealCount":184,
   "avgDealSize":39348,"winRate":64.6},"monthlyRevenue":[...]
```

### Lead Conversion — `GET /api/reports/lead-conversion`

- **HTTP 200**, 796 bytes
- KPIs: `totalLeads=28`, `qualified=0`, `inDeals=0`, `won=0`, `leadToDealRate=0`, `dealToWonRate=0`
- Funnel populated (Leads → Qualified → In Deal → Won shape returned)
- Body snippet:
```
  {"data":{"kpis":{"totalLeads":28,"qualified":0,"inDeals":0,"won":0,
   "leadToDealRate":0,"dealToWonRate":0},"funnel":[{"key":"leads",
   "label":"Leads","count":28,"conversionRate":100},...
```

### Director Scorecard — `GET /api/reports/director-scorecard`

- **HTTP 200**, 2837 bytes
- KPIs: `totalPipelineValue=$108,820,895.84`, `openDealCount=282`, `forecastCommit=$62.5M`, `forecastBestCase=$102.2M`, `winRate=64.2%`
- Risks: `dealsAtRisk=198`, `dealsAtRiskValue=$82.5M`, `stalledAccounts=51`, `overdueTasks=2014`, `missedFollowUps=233`
- `repPerformance` array populated
- Body snippet:
```
  {"data":{"kpis":{"totalPipelineValue":108820895.84,"openDealCount":282,
   "forecastCommit":62531795.64,"forecastBestCase":102194549.81,"winRate":64.2},
   "risks":{"dealsAtRisk":198,"dealsAtRiskValue":82561754.28,
   "stalledAccounts":51,"overdueTasks":2014,"missedFollowUps":233},...
```

## Result

All four endpoints that were returning 500 prior to this PR now return 200 with
populated, sensible data. The fix is live.

## Browser smoke

Not run explicitly. The API smoke evidence above proves the SQL-level fix is
deployed and serving — page-level rendering would only catch an unrelated
front-end class of bug. The brief allows substituting evidence for a strict
browser-load check; this is documented for transparency.
