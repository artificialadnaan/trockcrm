# Corrective-action approval — completion design (approve/reject UI + the email chain)

Date: 2026-07-28
Extends: `2026-07-27-corrective-action-approval-design.md` (§3 Approval, §4 Notifications)
Depends on: PR #973, **merged** to `main` as `60631ed2` on 2026-07-28

This document covers only what is **left**. The state machine, storage and rendering are built; the
round trip is not. Where this contradicts the earlier spec, this one wins — it was written against the
implemented code rather than ahead of it.

---

## 1. State of play

Verified against the branch, not remembered.

### Built and green (`feat/corrective-action-approval`, 12 commits, gate 714/6299)

| Piece | Where |
| --- | --- |
| Migration 0202 — `resolved`→`submitted`, `approved`/`rejected`, outstanding index, event table, per-attempt photo link | `migrations/0202_corrective_action_approval.sql` |
| Shared status sets + `isCorrectiveActionOutstanding` | `shared/src/types/corrective-action-status.ts` |
| `QC_APPROVER_EMAILS` allowlist parser | `shared/src/lib/correctiveActionApprovers.ts` |
| Append-only event thread service | `server/src/modules/field/corrective-action-events.ts` |
| approve / reject / approve-all state machine | `server/src/modules/field/corrective-action-approval.ts` |
| Authz + request parsing (403 fail-closed on empty list) | `server/src/modules/field/corrective-action-approval-routes.ts` |
| HTTP routes, mounted | `server/src/modules/deals/routes.ts:2580` (approve), `:2601` (reject) |
| PDF thread rendering | `server/src/modules/field/scorecard-pdf.ts` |
| CRM thread rendering + 4-state badges | `client/src/pages/deals/deal-scorecards-tab.tsx` |
| QC dashboard "Awaiting Approval" bucket | `client/src/pages/reports/qc-reports-page.tsx` |

### Missing — this document's scope

1. **No approve/reject controls in the UI.** The API is reachable only by hand. James cannot act.
2. **The "awaiting your approval" email is enqueued and silently discarded.**
   `enqueueCorrectiveActionApprovalRequested` (`corrective-actions-service.ts:222`) inserts a job with
   `phase: "awaiting_approval"`, but the worker's payload guard
   (`scorecard-corrective-action-oversight-email.ts:180`) accepts only `opened | closed` and returns early.
   The job completes successfully having sent nothing. **This is the single highest-value gap:** it is
   already wired end to end except for one union type and one stamp column.
3. **No rejection notice.** A rejected item returns to the responder with no email at all.
4. **The completion email still says "complete"**, not "approved".
5. **A card's generation does not advance when an item changes without the CARD status changing** — see §4.

---

## 2. The email chain, end to end

Five messages. Two exist and are unchanged, one exists and is relabelled, two are new.

| # | Trigger | To | Subject | State |
| --- | --- | --- | --- | --- |
| 1 | card → `corrective_action_open` | super/PM responders | "Corrective action required" | exists, body change (§3.2) |
| 2 | card → `corrective_action_open` | `FIELD_SCORECARD_EMAIL_RECIPIENTS` | "Corrective Action Opened" | unchanged |
| 3 | card → `corrective_action_submitted` | `QC_APPROVER_EMAILS` | "Corrective action awaiting your approval" | **new phase** (§3.1) |
| 4 | any item rejected | super/PM responders | "Corrective action returned — changes requested" | **new** (§3.2) |
| 5 | card → `corrective_action_closed` | `FIELD_SCORECARD_EMAIL_RECIPIENTS` | "Corrective Action Approved" | exists, relabel (§3.3) |

Deliberately **not** sent: a "your fix was approved" note to the responder. The CRM shows it, and a
terminal-good-news email on every item is the inbox noise the whole feature is meant to avoid. Reversible
later if James asks for it.

### 3.1 — Message 3: awaiting approval

Reuses the oversight job wholesale. The phase union gains `awaiting_approval`; everything else — the
browsable gate, supersession markers, delivery-time revalidation, the PDF attachment, the send-then-stamp
model — applies unchanged, which is the entire reason for extending that job rather than writing a third one.

Two things it must NOT inherit:

- **Recipients.** Messages 2 and 5 go to `FIELD_SCORECARD_EMAIL_RECIPIENTS` (who watches). Message 3 goes to
  `QC_APPROVER_EMAILS` (who can act). Same config that authorizes the verb, so the people notified and the
  people able to act cannot drift. If the list is empty the job logs and returns — matching the API, which
  403s everyone, and matching the existing empty-recipient behaviour, which is not an error.
- **The responder subtraction.** Message 2 subtracts the cycle's responders; message 3 must not — an
  approver who happens to also be a super on some other card still needs this.

Needs a third stamp column, `corrective_action_approval_requested_at` (migration 0203), because
`stampColumn(phase)` is a literal switch over phase → column and the phase's own stamp is what encodes "this
cycle has been notified". Reusing either existing column would make an approval request suppress an opened or
closed notice.

### 3.2 — Message 4: rejection returns to the responder

**Reuses the existing responder email job rather than adding a new one.** This is the important design
decision here, and it follows from a constraint: the responders' tokens were revoked when they submitted, so
any rejection notice carrying a stale link sends someone an email they cannot act on. The fix for that is
exactly what `restartCorrectiveActionCyclesForCards` already does — mint a fresh cycle nonce, delete stale
tokens, re-enqueue the responder job — and that machinery carries thirteen rounds of hardening around
idempotency, supersession and delivery stamps. Writing a second token path would duplicate all of it.

So a rejection calls the existing restart helper, and the existing responder email gains rejection awareness.

**The worker DERIVES "this is a return" from state, never from the payload.** If any item on the card is
`rejected` at send time, the message is a return: different subject, and each rejected item shows the
approver's most recent rejection comment above the response form. Deriving beats a payload flag because the
job runs ~120s after enqueue and the payload cannot be re-checked, while state can — the same reasoning that
put the browsable gate and the status guard at delivery time rather than enqueue time.

### 3.3 — Message 5: relabel

`buildOversightEmail`'s `closed` phase says "is complete. Every flagged item has been documented." Under the
gate that is false — documented is not accepted. Becomes "has been approved. Every flagged item was
documented and approved by <approver>." The subject changes from "Completed" to "Approved".

The trigger does not move: the card reaches `corrective_action_closed` only on final approval now, so the
existing enqueue site is already correct.

---

## 4. The generation bug this work must fix first

`recomputeCardStatus` (`corrective-action-approval.ts`) early-returns when the recomputed card status equals
the current one:

```ts
if (cardStatus === currentStatus) return { cardStatus, changed: false };
```

Approving 1 of 3 items writes an `approved` event and changes the item row, but leaves the card in
`corrective_action_submitted` — so the card's `updated_at` never advances. `updated_at` **is** the PDF's
content generation, and the currency check is an equality against it, so the artifact still classifies as
current. **The downloaded PDF omits the approval.**

That is the originally reported bug, reintroduced by this branch. The same applies to rejecting one item on a
card that already had another item open.

Fix: always bump the card's generation when any item on it changed, whether or not the card's own status
moved. This is the round-13 lesson (`fix(scorecards): review round 13`) applied to a second writer.

---

## 5. UI

Per-item **Approve** and **Reject** on the deal Scorecards tab, plus a card-level **Approve all** when more
than one item awaits approval. Reject opens a required comment box; an empty comment is refused client-side
and server-side (the server already does).

Visibility is decided by a server-provided boolean, never by the client re-deriving the allowlist. The
allowlist itself must not reach the browser: it is an authorization config, and shipping it would tell every
CRM user who can sign off. `canApproveCorrectiveActions(req, env)` already exists for exactly this and is
currently unused — the scorecard detail response carries its result as `canApproveCorrectiveActions: boolean`.

The gate stays server-authoritative. Hiding the controls is UX; the 403 is the guarantee.

---

## 6. Out of scope (unchanged from the original spec)

- Magic-link approval from the inbox.
- Approval from the mobile CRM app.
- Any escalation, reminder or SLA on a card sitting in `corrective_action_submitted`. **The consequence
  stands and is accepted: if James is away, cards wait indefinitely.** Nothing in this document changes that.
- Backfilling existing `corrective_action_closed` cards — they stay closed and unreviewed.

---

## 7. Testing

Beyond the existing suites:

- **Phase routing:** an `awaiting_approval` job resolves the APPROVER list, not the watcher list; stamps its
  OWN column; and does not subtract responders.
- **Empty approver list:** logs and returns, sends nothing, stamps nothing.
- **Rejection loop, end to end:** reject → the card reopens → a fresh cycle nonce is minted → stale tokens are
  deleted → a responder job is enqueued → the emailed link authorizes the responder.
- **Derived return:** the responder email's subject and body reflect a rejection when an item is `rejected` at
  send time, with the approver's comment, and do not when it is a first request.
- **Generation:** approving one item of three advances the card's `updated_at` strictly, and the next download
  re-renders. This test must FAIL against the current `recomputeCardStatus`.
- **UI gate:** controls render for an allowlisted user and not otherwise; the raw allowlist never appears in
  any response body.

Run with `TZ=UTC`. Gate is `npm run check:premerge`, plus `npx vitest run worker/` by hand — the worker
package still has no `test:ci`, so nothing else covers the three jobs this touches.
