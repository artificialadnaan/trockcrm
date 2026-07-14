# Main Deals Dashboard Won YTD incident — July 2026

## Finding

The reported reduction was on the **main Deals Dashboard**, not the Estimator Pipeline.

Replaying the audit trail against the exact live board predicate (genuine Won stage, active, not held, not test, canonical `won_closed_date` in the current YTD window, awarded-first value chain) found an exact **net -$304,815.62** between July 1 and July 14:

- 18 `wonClosedDate` edits moved $652,782.03 out of YTD.
- 2 `wonClosedDate` edits moved $347,966.41 into YTD.
- All 20 actions were `update` actions by **Kristy Scheidegger**.

This is a real data movement, not an Estimator Pipeline or Deals Dashboard query-definition regression. It is a July 1–14 baseline comparison rather than one single overnight action. The audit snapshot's canonical board was **275 deals / $18,002,178.07**; live counts can move as valid deals are added or changed.

No production data was changed during this investigation.

## Audit evidence

| Date (CT) | Audit action | Effect on Won YTD |
| --- | --- | ---: |
| Jul 6 | #7664428 — Club at Riverchase: `2026-06-03` → `2023-06-02` | -$341,549.14 |
| Jul 8 | #7992520 — Club at Riverchase: `2023-06-02` → `2026-06-02` | +$341,549.14 |
| Jul 7 | #7778611 Rise North Arlington, #7778618 Arcadian Business Center, #7788009 Denton Student Housing moved from 2026 into 2025; #7788019 TForce Properties HVAC moved into 2026; #7790361 the quarters leak moved into 2025 | -$119,842.95 net |
| Jul 9 | #8215201 Tides Park Lane Window Trim/Siding and #8215210 Timberglen City Repairs moved from 2026 into 2025 | -$116,527.00 |
| Jul 13 | #8936190, #8938727, #8938744, #8949009, #8954146, #8954164, #8954175, #8956709, #8956724, #8956745, #8959233 moved from 2026 into 2025 | -$68,445.67 |

The largest Jul 13 action was #8936190 (Gateway East garage mailboxes), `2026-01-05` → `2025-08-15`, -$14,743. There were no matching Won-to-non-Won transitions, archive/soft-delete, hold, test-data, or material Won-value reductions responsible for the $304.8k change.

## Separate board/detail reconciliation defect

The screenshots' **275 / $18.0M** versus **278 / $18.2M**, and later **276** versus **279**, are unrelated to the July date edits. The board correctly filters `is_active=true`; the Won detail page did not. In both cases the mismatch is exactly three rows.

The three extra soft-deleted Won rows total **$165,060.76**:

- #2110636 — Hendrix–Full Property Stucco Paint, $144,642.76, soft-deleted by Kaleb Marshall on Jun 1 at 21:12 CT.
- #4500180 — Elan Sweetwater Creek, $15,245.71, soft-deleted by Adnaan on Jun 17 at 16:33 CT.
- #3363982 — Tides on Timberglen Slab Leak, $5,172.29, soft-deleted by Takashi on Jun 10 at 19:55 CT.

The normal Won stage detail now applies the board’s `is_active=true` predicate; an explicit inactive status remains available for diagnostics.

## Remediation and decision

- The PR adds durable, cited Won-reduction alerts for office/rep Won all-time, WTD, MTD, QTD, and YTD figures, plus published definition snapshots for the main Deals Dashboard and Estimator Pipeline Won YTD figures.
- Every alert includes the before/after amount and count, reason, exact changed fields, audit action/actor/time/ID, and a direct link.
- The alert recipients default to Takashi and Adnaan.

Restoring the $304,815.62 requires a business decision on the affected historical close-date corrections; it should not be automatically reversed merely to raise a dashboard total.
