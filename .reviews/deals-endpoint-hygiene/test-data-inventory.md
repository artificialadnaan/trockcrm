# Test-data inventory — office_dallas

Read-only audit run 2026-05-28T03:38:47.322Z against `trolley.proxy.rlwy.net:30423`.
All queries ran inside a `SET TRANSACTION READ ONLY` transaction (rolled back).

## Summary

| Metric | Count |
| --- | --- |
| Deals currently flagged `is_test_data = true` | 3 |
| Suspected unflagged (name matches a test/demo pattern) | 8 |
| — of those, REVIEW_REQUIRED (likely false positive) | 8 |
| — of those, safe to auto-mark | 0 |

## Suspected, broken down by primary matched pattern

| Pattern | Matches | REVIEW_REQUIRED | Auto-mark safe |
| --- | --- | --- | --- |
| `tides fire demo` | 0 | 0 | 0 |
| `trock template` | 0 | 0 | 0 |
| `test project` | 0 | 0 | 0 |
| `sandbox` | 0 | 0 | 0 |
| `demo` | 8 | 8 | 0 |
| `example` | 0 | 0 | 0 |
| `dummy` | 0 | 0 | 0 |
| `placeholder` | 0 | 0 | 0 |
| `template` | 0 | 0 | 0 |

## REVIEW_REQUIRED rule

A suspected row is flagged REVIEW_REQUIRED (excluded from any auto-mark) when **any** of:
- primary matched pattern is the broad `template` (e.g. "Tides on Templeton" — a real property), or
- the deal has a `project_number` (converted to a real project), or
- `awarded_amount > 0` (real contract value), or
- the assigned rep also owns genuine (non-suspected) deals.

## Recommended action

- **Auto-mark safe (0 rows):** primary pattern in {sandbox, test project, trock template, tides fire demo, demo, example, dummy, placeholder} with no real-deal signal. These are candidates for `scripts/mark-test-data.ts --commit`.
- **Operator review (8 rows):** REVIEW_REQUIRED — do not auto-mark; eyeball each in the CSV.
- The `template` pattern is intentionally **never** auto-marked: it is the largest false-positive source.

Artifacts:
- `test-data-flagged.csv` — the 3 already-flagged deals.
- `test-data-suspected.csv` — the 8 suspected rows with per-row flags.
