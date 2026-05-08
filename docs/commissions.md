# Commission Model

## Current behavior

The CRM creates earned commission rows in `deal_signed_commissions` when a deal's contract signed date transitions from empty to set. The insert is intentionally one-time: after the row exists, later deal edits do not recalculate, update, reverse, or silently replace the commission amount.

The calculation source value uses the first available deal amount in this order:

1. `awardedAmount`
2. `bidEstimate`
3. `ddEstimate`

The rate comes from `user_commission_settings.commissionRate` for the rep. `user_commission_settings.isActive` gates whether that rep is eligible for commission calculation.

The dedupe key is `(dealId, repUserId)`. Today that matches the one-row-per-deal-per-rep contract-signing model.

## What this model does not do

- It does not recalculate commission after later edits to award amount, estimates, or commission settings.
- It does not reverse commission if the signed date is cleared.
- It does not silently update an existing commission row.
- It does not treat payment events as the source of truth for earned commission.

## Deferred behavior

Future Procore change-order handling is expected to add additive commission rows instead of mutating the original signed-commission row. When that lands, the `(dealId, repUserId)` dedupe constraint will need to be revisited so change-order rows can coexist with the original contract-signing row.

Per-deal commission subcards on the commissions page are deferred to post-launch UI work.

An admin commission adjustment endpoint is deferred to a future server-side prompt.
