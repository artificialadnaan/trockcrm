# Monday Showcase A1 — Supporting Records, Sorting, and Record Navigation

## Objective

Make the A1 Estimating Report self-service. A leadership viewer must be able to open the records behind a displayed A1 number, sort the operational tables without exporting, and open a displayed deal in a separate CRM tab.

## Scope

This is a client-only enhancement to A1. The existing `estimatingReport` payload already carries the three exact cohorts that define its figures:

- the live Current Estimating queue;
- the selected-period current RFP-request cohort; and
- the selected-period sent-stage-entry cohort.

It must **not** reuse the shared Monday Showcase evidence drawer. Its `estimated` and `sent` metrics have different definitions and value bases, and it has no RFP cohort. Re-querying it would make a dialog look authoritative while failing to reconcile to the A1 number that opened it.

## Supporting-record dialogs

### Opening controls

The following controls open an accessible, scrollable A1-local dialog using the exact in-memory rows that support the displayed number:

| Control | Supporting rows |
| --- | --- |
| Current Estimating headline tile and section count pill | All `currentEstimating.projects` |
| New RFPs headline tile and section count pill | All `newRfps.projects` |
| Projects Sent headline tile and section count pill | All `estimatesSent.projects` |
| Blended Margin tile | Sent rows with both a positive latest Bid Board total and a present margin; this is the weighted-margin base |
| Sent financial tiles | The subset described by each tile’s own coverage rule (latest-total present, DD-and-total comparable, positive-DD percent-comparable, or margin-usable) |
| RFP salesperson RFP count, Known DD, and Missing DD controls | `newRfps.projects` filtered by that row’s current `assignedRepId`, then where applicable by a present or missing DD value |
| Salesperson total-row count / Known DD / Missing DD controls | All / present-DD / missing-DD `newRfps.projects`, respectively |

The dialog title and description state the cohort meaning, project count, and current activity period/as-of timestamp where relevant. It renders the source values necessary to audit the number; an empty eligible subset is shown honestly instead of silently falling back to all rows. It resolves the selected scope against the current payload rather than copying rows into state, and closes if that payload changes because of a period/filter/refresh update.

### Data semantics

- Current Estimating remains a live snapshot; its dialog states the current-as-of time and is unaffected by the period toggle.
- RFP dialog ownership is the **current** assigned sales rep, matching the rollup’s existing reassignment caveat. It filters by `assignedRepId`, never display name, so duplicate names and the `Unassigned` (`null`) bucket remain exact.
- Sent dialog rows retain the existing caveat: DD, Bid Board total, variance, and margin are current/latest values, not immutable send-time snapshots.
- A sent dialog’s summary reconciles to the metric that opened it: latest-total dialogs show the latest-total sum; dollar/percent comparison dialogs show their eligible DD and latest-total bases plus variance; and the margin dialog shows its weighted latest-total base and blended margin.
- A dialog must never make a missing financial value appear as zero. A real zero DD participates in dollar comparison but not percent comparison; a real zero margin participates in blended margin where latest total is positive.

## Table sorting

Use the shared `useTableSort`, `SortHeaderButton`, and `ariaSort` primitives. Sorting is local to the loaded cohort and stable; null/unknown values remain last in both directions.

| Table | Sortable columns | First click |
| --- | --- | --- |
| Current Estimating | Project, Project #, Current stage, DD Estimate, Time in stage | text A→Z; DD/time high→low |
| New RFP submissions | Project, Project #, Request opened, Current RFP status, Current rep, DD Estimate | text A→Z; request newest→oldest; DD high→low |
| Projects sent | Project, Project #, First sent, Current DD, latest total, dollar variance, percent variance, latest margin | text A→Z; dates newest→oldest; numeric high→low |
| RFPs by salesperson | Salesperson, RFP count, Known DD, Missing DD | text A→Z; numeric high→low |

A second click reverses direction. Each sortable header has a 24px minimum hit target, visual direction indicator, an accurate accessible name, and `aria-sort` on its host header cell.

## Opening a deal

Every A1 project-row name is a native link to the corresponding CRM deal detail in a new tab. It uses `useDealHref()` so a cross-office `?officeId` scope survives. The link uses `target="_blank"` and `rel="noopener noreferrer"`.

The project name is the explicit accessible affordance; the table also describes this interaction near the data so viewers do not have to infer it from styling. The report does not claim these deal ids are the separate Projects-module ids. It does not make a table row a fake link, which would weaken keyboard and screen-reader behavior.

## Verification

Focused client tests must prove:

1. A headline and a sales-rep RFP count open a dialog containing only the exact supporting rows, including `Unassigned`.
2. Margin and comparison drill subsets honor their stated coverage, including real zero vs. missing values, and do not include null-ineligible records.
3. Project links target `/deals/:id`, open a new tab, and preserve `officeId`.
4. Request-opened, DD Estimate, and Time-in-stage headers sort both directions, with correct `aria-sort` and nulls last.
5. An open dialog closes when its underlying A1 payload changes.
6. Dialog and table interactions preserve the existing visual data/caveats and do not request generic Showcase evidence.

The full client test suite, workspace typecheck, and the Codex review loop are required before merge.
