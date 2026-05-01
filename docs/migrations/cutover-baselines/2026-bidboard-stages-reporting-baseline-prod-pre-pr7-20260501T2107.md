# 2026 Bid Board Stages Reporting Baseline - Production Pre-PR7

Purpose: pre-cutover parity baseline for PR 7 reporting changes. Re-run these same metrics after PR 7 deploys and compare using the tolerances in `docs/migrations/2026-bidboard-stages-migration-plan.md` section H.

- Environment: production
- Query timestamp UTC: `2026-05-01T21:07:10.156Z`
- Git SHA captured from main: `9ad2abf6dc6c00e8b1fac1a6beae6b8f43bac0ef`
- Window: last 90 days, using section H query semantics

## Tolerances

| Metric | Tolerance |
| --- | --- |
| Win rate | +/- 0.1 percentage points |
| Commissions earned | +/- 0.1% |
| Contracts signed count | Exact match required |
| Lost deals count | Exact match required |

## Results

| Tenant | Won Count | Lost Count | Terminal Count | Win Rate % | Commission Deal Count | Earned Commission | Contracts Signed Count | Lost Deals Count |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| office_atlanta | 0 | 0 | 0 | null | 0 | 0.00 | 0 | 0 |
| office_dallas | 266 | 195 | 461 | 57.701 | 0 | 0.00 | 1 | 195 |
| office_pwauditoffice | 0 | 0 | 0 | null | 0 | 0.00 | 0 | 0 |

## Raw Output

```json
{
  "queryTimestamp": "2026-05-01T21:07:10.156Z",
  "results": [
    {
      "tenant": "office_atlanta",
      "winRate": {
        "won_count": 0,
        "lost_count": 0,
        "terminal_count": 0,
        "win_rate_pct": null
      },
      "commissionsEarned": {
        "commission_deal_count": 0,
        "earned_commission": "0.00"
      },
      "contractsSigned": {
        "contracts_signed_count": 0
      },
      "lostDeals": {
        "lost_deals_count": 0
      }
    },
    {
      "tenant": "office_dallas",
      "winRate": {
        "won_count": 266,
        "lost_count": 195,
        "terminal_count": 461,
        "win_rate_pct": "57.701"
      },
      "commissionsEarned": {
        "commission_deal_count": 0,
        "earned_commission": "0.00"
      },
      "contractsSigned": {
        "contracts_signed_count": 1
      },
      "lostDeals": {
        "lost_deals_count": 195
      }
    },
    {
      "tenant": "office_pwauditoffice",
      "winRate": {
        "won_count": 0,
        "lost_count": 0,
        "terminal_count": 0,
        "win_rate_pct": null
      },
      "commissionsEarned": {
        "commission_deal_count": 0,
        "earned_commission": "0.00"
      },
      "contractsSigned": {
        "contracts_signed_count": 0
      },
      "lostDeals": {
        "lost_deals_count": 0
      }
    }
  ]
}
```
