# No automated tasks on closed deals

**Status:** implemented · **Branch:** `fix/no-tasks-on-terminal-deals` · **Date:** 2026-09-12

## The report

Andrew Green (rep, `office_dallas`), 2026-09-12 03:23, filed as *"CRM not communicating with Procore"*:

> I am being tasked follow ups, and they are going against my SLA. The notifications are from projects
> that are won and closed or lost. — `DFW-4-22226-ag`, `DFW-4-22226-ab`, `DFW-4-11826-ae`

## Diagnosis

The complaint is real. The stated cause is not: **Procore is not involved.** Procore never drives CRM
stage (that sync is link/photo-only), and none of the offending tasks originate from it. The CRM held the
correct terminal stage the entire time — the generators simply never asked.

Verified on prod:

| Deal | Stage | Went terminal | Task minted | Gap |
| --- | --- | --- | --- | --- |
| `DFW-4-22226-ag` | **Won** (`is_terminal=t`) | 2026-08-10 20:22 | 2026-09-03 | **+24 days** |
| `DFW-4-22226-ab` | **Lost** (`is_terminal=t`) | 2026-08-28 18:15 | 2026-09-03 | **+6 days** |

`DFW-4-11826-ae` does not exist in any office schema — almost certainly a typo. Andrew in fact had **14**
open tasks on Won/Lost deals, not three.

### Root cause

`is_terminal = false` appeared exactly **once** in `worker/src/jobs/daily-tasks.ts` — on the stale-*lead*
query. Neither follow-up generator checked it, nor did the inbound-email or AI-disconnect paths.

### Why it repeated — the part that made it self-sustaining

`deals/stage-change.ts:497` already dismisses open tasks when a deal reaches a terminal stage. That
dismissal is *exactly* what cleared each generator's `NOT EXISTS (open task of this kind)` guard. So:

```
Day N      deal goes Won  -> stage-change dismisses its open tasks        (correct)
Day N+1    6am job: no open follow-up exists, close date still in window
           -> re-mints the follow-up onto the Won deal                    (the bug)
```

Closing a deal *granted permission* to re-mint. Any fix that only drains the backlog reopens the loop the
next morning, which is why the create-side filters and the dismissal pass have to be complements on one
axis — the deal's stage.

### Blast radius (prod, `office_dallas`, 2026-09-12)

**3,395** open tasks on Won/Lost deals across up to 14 reps, 114 minted in the preceding 7 days:

| Origin rule | Won | Lost | Source |
| --- | --- | --- | --- |
| `inbound_email_reply_needed` | 1,891 | 86 | `email-sync.ts` |
| `ai_disconnect_admin_task` | 313 | 464 (+1) | `ai-disconnect-admin-tasks.ts` |
| `daily_cadence_overdue_follow_up` | 201 | 216 | `daily-tasks.ts` |
| `daily_close_date_follow_up` | 51 | 42 | `daily-tasks.ts` |
| `cold_lead_warming` | — | 3 | pre-existing debris; that job is already filtered |
| manual (`origin_rule IS NULL`) | 70 | 56 | **out of scope — human intent** |
| `scoping_estimating_review_handoff` | — | 1 | **out of scope — post-close by design** |

Two aggravating factors found while diagnosing:

1. **Terminal stages carry a touchpoint cadence.** Prod has `touchpoint_cadence_days = 14` on both Won and
   Lost, and `last_contacted_at` only ages — so the cadence rule re-minted on *every* closed deal forever.
2. **The AI-disconnect job was starving itself.** Its branches `ORDER BY age_days DESC` under a `LIMIT 10`,
   and a closed deal's disconnect only gets older. Closed work was crowding live disconnects out entirely.

### Second, independent defect: `is_overdue` was write-once

`daily-tasks.ts` only ever set `is_overdue = true`; nothing reset it. So moving a due date forward left the
task flagged overdue permanently — on prod, tasks due **2026-12-01** were still flagged, still forced to
`priority = 'urgent'`, and still emitting a daily *"Task … is overdue (due 2026-12-01)"* notification.

The list buckets read `due_date < today`, so these did not appear in Overdue — but the notifications and
the urgent sort are real, and they are what Andrew was seeing.

## Scope

**In:** terminal-stage filters on the four generators; a dismissal pass that drains the backlog; a
reciprocal `is_overdue` clear; an inert dry-run/`--commit` drain script.

**Out:** un-escalating `priority` that the job forced to `urgent` (the original value is not recoverable);
the 126 manual tasks on closed deals; adding an `is_test_data` filter to the close-date rule
(`TR-DEMO-*` deals omit that flag anyway, so it would not help).

## Design decisions

- **Allowlist, not `origin_rule IS NOT NULL`.** Post-close rules (won-handoff, cross-sell,
  competitor-intel, estimating-review) exist *because* the deal closed; manual tasks are a person's stated
  intent filed after the transition already swept the deal. Sweeping either would destroy real work.
  The dry-run confirms the arithmetic: 3,395 − 126 manual − 1 post-close = **3,268** in scope.
- **`suppressed_until` stays NULL.** A deal can return to Opportunity, and when it does these tasks should
  be free to mint again. The 0-day rules resume immediately; `inbound_email_reply_needed` rides its own
  30-day window. Same contract as the sibling dismissers.
- **Email association is preserved.** For `email-sync.ts` only the reply-needed *task* is suppressed. The
  email is still stored, still associated with the deal, still written as an activity, still counted in the
  deal's email stats — a message about a closed job belongs on that job's timeline.
- **One statement, not a loop.** The first run drains ~3,268 rows in one office; the sibling dismissers'
  UPDATE-then-loop shape would be that many sequential round-trips inside one transaction holding the
  office advisory lock. Measured: it did not finish in 10 minutes against the prod proxy. The pass is a
  single data-modifying CTE.
- **Order matters inside the job:** drain → clear `is_overdue` → mark `is_overdue` → notify. Draining after
  the notification INSERT would let the cleanup run send one last round of nags.

## Verification

Create-side assertions **execute** the SQL the job really issues (captured from the run, `${schemaName}`
substituted, run against PGlite) rather than asserting on its text, so a reworded comment proves nothing
and a deleted predicate cannot hide.

**12 mutations, all caught** — see the PR body for the table. One (`LEFT JOIN` → `JOIN` on the deal-parent
lookup) *survived* the first pass and exposed a genuine coverage hole: a stubbed query cannot tell the two
apart. Closed by executing the captured lookup against a stageless deal.
