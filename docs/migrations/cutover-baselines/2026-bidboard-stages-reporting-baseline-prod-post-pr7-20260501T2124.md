# 2026 Bid Board Stages Reporting Baseline - Production Post-PR7

Purpose: post-deploy parity verification after PR 7 (`#96`) and the commission hotfix (`#98`) deployed to production.

- Environment: production
- Baseline file: `docs/migrations/cutover-baselines/2026-bidboard-stages-reporting-baseline-prod-pre-pr7-20260501T2107.md`
- Baseline query timestamp UTC: `2026-05-01T21:07:10.156Z`
- Post-deploy query timestamp UTC: `2026-05-01T21:24:17.227Z`
- Baseline main SHA: `9ad2abf6dc6c00e8b1fac1a6beae6b8f43bac0ef`
- Post-deploy main SHA: `2351f8e6eb9b3c417bf146d5c2be0a1a7f55e8c4`
- Window: last 90 days

## Tolerances

| Metric | Tolerance |
| --- | --- |
| `win_rate_pct` | +/- 0.1 percentage points |
| `earned_commission` | +/- 0.1%, except expected PR7 semantic correction noted below |
| `contracts_signed_count` | Exact match required |
| `lost_deals_count` | Exact match required |
| `won_count` | Exact match sanity check |
| `lost_count` | Exact match sanity check |

## Comparison

| Tenant | Metric | Baseline | Post Deploy | Delta | Within Tolerance? |
| --- | --- | ---: | ---: | ---: | --- |
| office_atlanta | won_count | 0 | 0 | 0 | yes |
| office_atlanta | lost_count | 0 | 0 | 0 | yes |
| office_atlanta | win_rate_pct | null | null | n/a | yes |
| office_atlanta | earned_commission | 0.00 | 0.00 | 0.00 | yes |
| office_atlanta | contracts_signed_count | 0 | 0 | 0 | yes |
| office_atlanta | lost_deals_count | 0 | 0 | 0 | yes |
| office_dallas | won_count | 266 | 266 | 0 | yes |
| office_dallas | lost_count | 195 | 195 | 0 | yes |
| office_dallas | win_rate_pct | 57.701 | 57.701 | 0.000 | yes |
| office_dallas | earned_commission | 0.00 | 24500.00 | +24500.00 | expected anomaly: see analysis |
| office_dallas | contracts_signed_count | 1 | 1 | 0 | yes |
| office_dallas | lost_deals_count | 195 | 195 | 0 | yes |
| office_pwauditoffice | won_count | 0 | 0 | 0 | yes |
| office_pwauditoffice | lost_count | 0 | 0 | 0 | yes |
| office_pwauditoffice | win_rate_pct | null | null | n/a | yes |
| office_pwauditoffice | earned_commission | 0.00 | 0.00 | 0.00 | yes |
| office_pwauditoffice | contracts_signed_count | 0 | 0 | 0 | yes |
| office_pwauditoffice | lost_deals_count | 0 | 0 | 0 | yes |

## Analysis

### Earned Commission

Dallas earned commission moved from `$0.00` to `$24,500.00`.

This is the expected PR7 semantic correction, not a parity failure. The pre-PR7 baseline query used the old earned-at-won stage filter. The deployed PR7 commission logic now recognizes earned commission at contract signing using:

- `contract_signed_at::date`
- `contract_signed_date`
- `deal_signed_commissions.contract_signed_date_at_signing`

The old legacy commission query still returns `$0.00` after deploy, while the PR7 earned-at-signing query finds one Dallas signed-commission deal. That confirms the variance comes from the intended semantics change rather than unexpected data drift.

### Contracts Signed Count

Contracts signed count remained `1` for Dallas.

PR1 backfilled three signed rows in Dallas, but two of those rows are test data and are intentionally excluded by the parity query's `COALESCE(is_test_data, false) = false` filter. The signed-row diagnostic returned:

| Tenant | Deal Number | Test Data? | Stage Slug | Signed Date | In 90-Day Window? |
| --- | --- | --- | --- | --- | --- |
| office_dallas | TEST-DIR-003 | true | won | 2026-04-27 | true |
| office_dallas | TEST-REP-007 | true | won | 2026-04-27 | true |
| office_dallas | TR-DEMO-001 | false | estimate_in_progress | 2026-04-20 | true |

So the `1` post-deploy count is correct. The two excluded rows are not outside the 90-day window; they are excluded because they are marked test data.

## Raw Post-Deploy Output

```json
{
  "queryTimestamp": "2026-05-01T21:24:17.227Z",
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
      "legacyCommissionQuery": {
        "commission_deal_count": 0,
        "earned_commission": "0.00"
      },
      "contractsSigned": {
        "contracts_signed_count": 0
      },
      "allSignedRows": {
        "signed_total_count": 0,
        "signed_older_than_90_count": 0,
        "earliest_signed_date": null,
        "latest_signed_date": null
      },
      "signedDetail": [],
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
        "commission_deal_count": 1,
        "earned_commission": "24500.00"
      },
      "legacyCommissionQuery": {
        "commission_deal_count": 0,
        "earned_commission": "0.00"
      },
      "contractsSigned": {
        "contracts_signed_count": 1
      },
      "allSignedRows": {
        "signed_total_count": 1,
        "signed_older_than_90_count": 0,
        "earliest_signed_date": "2026-04-20",
        "latest_signed_date": "2026-04-20"
      },
      "signedDetail": [
        {
          "deal_number": "TR-DEMO-001",
          "stage_slug": "estimate_in_progress",
          "signed_date": "2026-04-20"
        }
      ],
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
      "legacyCommissionQuery": {
        "commission_deal_count": 0,
        "earned_commission": "0.00"
      },
      "contractsSigned": {
        "contracts_signed_count": 0
      },
      "allSignedRows": {
        "signed_total_count": 0,
        "signed_older_than_90_count": 0,
        "earliest_signed_date": null,
        "latest_signed_date": null
      },
      "signedDetail": [],
      "lostDeals": {
        "lost_deals_count": 0
      }
    }
  ]
}
```

## Recommendation

All clear. Proceed to PR 8 cleanup.
