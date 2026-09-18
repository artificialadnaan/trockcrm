# Service workflow: CRM delivery contract

Implements CRM portions S01–S03 and S15 of the coordinated 2026-09-07 Core/CRM specification. The independent review covered report evidence, assignment eligibility, existing scoping intake, and downstream naming.

## Intake and handoff

Quick Service Opportunity uses the canonical dashboard sales-generating roster, restricted to current office assignment eligibility. Historical ownership alone still qualifies for a board filter, but cannot grant new assignment access. The `assignableOnly=1` roster option is opt-in; existing dashboard behavior is unchanged. Rep/source selects display names and preserve their selected identity during asynchronous option reloads.

Scope title and description remain separately editable and optional at creation. A service RFP requires at least one nonblank scope field. Readiness resolves the effective summary after existing intake data is merged; normal workflows keep their existing requirements. Missing RFP scope returns a clear field-level instruction.

The outbound RFP `deal.name` becomes `Property - Opportunity`, bounded to 300 characters and without repeated matching prefixes. The CRM's stored opportunity name is untouched. The existing SyncHub contract already forwards this name to Bidboard/Core; optional `deal.propertyName` and `deal.scopeTitle` metadata are also supplied. Service description falls back to scope title. No existing project renaming/backfill is performed.

## Contribution report

`/reports/sales/service-rfps` / `GET /api/reports/service-rfps` shows distinct service RFP contributions by salesperson, total and weekly in the selected range, plus supporting deals. Weeks start Monday in America/Chicago; partial boundary weeks are labelled. Date range is bounded to ten years. Existing role and active-office boundaries apply, with reps forced to their own attribution filter.

Migration `0245_service_rfp_submissions.sql` adds a public table keyed by office and deal. The first successful service reservation/outbox enqueue captures timestamp and assigned-rep identity/name inside the same transaction. Retries, cancellation/re-entry and reassignment do not overwrite it. The requester and sales-source person are not counted as additional contributors.

Historical fallback uses the earliest retained RFP outbox with a service type in its persisted payload. Such rows explicitly disclose current-owner attribution (or owner when the historical record was captured); they do not claim an immutable historical salesperson. A service submission remains counted after later reclassification. A bare current stage, creation date, or RFP-request timestamp without service-at-submission evidence never proves a contribution. Deals without evidence are shown separately across all dates and may never have been submitted.

Active eligible zero-contribution reps, historical inactive contributors and unattributed submissions remain visible. Archived deal evidence retains its count and is labelled without a broken live-deal link. Export includes counts and evidence. No historical submission timestamps are fabricated.

## Verification and operations

Focused tests cover actual RFP outbox/snapshot transaction integration, rollback, retries, reassignment, historical reclassification, inactive/zero/unattributed reps, cross-office history isolation, revoked assignment membership, Chicago Sunday/Monday boundaries, scope alternatives with existing blank intake, real select interactions/reloads, naming limits, report role enforcement and report evidence links.

The API deployment must apply migration 0245 before serving the new enqueue/report code. Standard migration startup provides this ordering. No new service credentials or external notifications are introduced by CRM changes. Root delivery orchestration owns final CI, independent PR review, merge, deployment verification and production browser evidence.
