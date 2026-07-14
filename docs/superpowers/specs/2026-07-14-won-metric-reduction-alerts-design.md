# Won-metric reduction alerts

## Outcome

Takashi Yamashita and Adnaan Iqbal receive one durable, evidence-backed alert whenever a published Won figure falls. The alert identifies the affected figure, before/after value and count, reason, exact CRM action and audit citation, plus a direct deal or report link.

This design was added after the July main-Deals-Dashboard incident: cited `wonClosedDate` corrections moved Won value out of YTD without any advance notification, and a separate board/detail query-scope difference made the two views disagree.

## Published metrics covered

The mutation detector compares the old and new contribution of a changed deal for these canonical CRM Won figures:

- Office and assigned-rep Won all-time, WTD, MTD, QTD, and YTD.
- Estimator Pipeline Won YTD as a separately named figure (`estimator_pipeline.won_ytd`). It uses that report's published effective-stage/value definition and is not conflated with the Deals Dashboard's CRM-stage Won YTD.

The detector runs in an `AFTER UPDATE`/`AFTER DELETE` trigger on every tenant `deals` table. It covers stage, Won date, awarded/value-basis fields, hold/archive/test/change-order flags, assigned rep, and Bid Board stage changes. Definition snapshots record the stable all-reps/current-YTD main Deals Dashboard Won column and the Estimator Pipeline Won YTD result; a changed definition/hash that lowers either published figure creates the same alert even when no deal audit row changed.

User-defined/ad-hoc report-builder filters are deliberately excluded because they do not define a stable finite published metric. A newly published Won surface must register its definition through `record_won_metric_definition_snapshot` alongside its query so definition-only regressions are covered.

## Event contract

`public.won_metric_reduction_events` is an immutable outbox event containing:

- tenant, deal (when applicable), transaction, event kind, timestamps;
- old/new deal snapshots and exact changed fields;
- named metric impacts with before, after, dollar delta, count delta, and scope;
- a human-readable action label and reason code;
- tenant audit-log IDs and transaction ID; or a definition version/hash and release reference for a code/configuration change.

The trigger preserves the first material contribution in a transaction and recomputes the final impact as subsequent writes occur. This means an intermediate reduction/increase cannot create a false alert: the worker only sends when the final committed event is negative.

## Delivery contract

The `won_metric_reduction_alert` worker job sends one email per recipient and creates a best-effort in-app notification for matching active CRM users.

- Non-production fallback recipients are Takashi (`tyamashita@trockgc.com`) and Adnaan (`adnaan@trockgc.com`). Production requires `WON_METRIC_DECREASE_EMAIL_RECIPIENTS`, which must name the approved corporate leadership audience.
- Each `(event_id, recipient_email)` has a persistent receipt.
- The worker atomically leases an unsent receipt before sending. A second worker cannot send while that lease is fresh.
- The Resend idempotency key is stable per event/recipient. A success stamps `sent_at`; a provider failure releases only that worker’s lease and throws so the normal queue retry can reclaim it.
- A final non-negative event is completed without email.

Every email includes the reason, exact action, changed field values, audit citation, release reference when present, before/after impact, and a deep link to the deal or matching Won surface.

The migration starts with queue delivery gated off. It always persists reduction events, but only a worker that has registered the new handler opens the gate and atomically backfills those durable events. That prevents a still-running older worker from dead-lettering the newly introduced job type during a rolling deploy.

## Deployment order

1. Deploy the handler-capable worker. It safely retries delivery-gate activation until migration `0184_won_metric_reduction_alerts.sql` exists.
2. Apply the migration and deploy server code (the server tolerates the short pre-migration window without the definition-snapshot function).
3. Set `WON_METRIC_DECREASE_EMAIL_RECIPIENTS` in production to the approved leadership recipient list; do not set an invalid or incomplete list.
4. Load the all-reps, current-YTD main Deals Dashboard and the Estimator Pipeline report once to establish their release-definition baselines.
5. Confirm the worker is consuming `won_metric_reduction_alert` jobs and verify an alert through a non-production deal update.

## Acceptance checks

- A Won deal placed on hold, archived, marked as test/change-order where the relevant figure excludes it, moved out of Won, rebucketed outside YTD, reassigned, reduced in value, or deleted creates a final negative event with an audit ID.
- A Bid Board-only stage change affects only the separately named Estimator Pipeline metric, never canonical CRM Won YTD.
- A positive then partial negative sequence in one transaction alerts only if its final result is below the original value.
- A deployed main Deals Dashboard or Estimator Won YTD definition/hash that reduces the published result creates a release-cited event even without a deal change.
- Retries and concurrent workers do not create duplicate recipient sends.
