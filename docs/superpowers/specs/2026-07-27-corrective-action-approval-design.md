# Corrective-action approval gate — design

Date: 2026-07-27
Depends on: `feat/scorecard-corrective-action-followups` (the PDF corrective-action section it renders into)
Supersedes part of: `2026-07-27-scorecard-corrective-action-followups-design.md` §3 (the "completed" oversight email)

## The change

Today a corrective action **auto-closes** the moment the last flagged item is answered. `resolveCorrectiveActionItemTx`
flips the item to `resolved`, sees no `open` rows remain, and writes `corrective_action_closed`. Nobody reviews
the work.

This inserts a review gate. A super/PM submission no longer closes anything — it goes to an approver, who
approves (closing it) or rejects with comments (bouncing it back). Every round trip is documented in both the
scorecard PDF and the CRM scorecard view.

Locked decisions:
- **Approver authority** = a dedicated `QC_APPROVER_EMAILS` allowlist, not a role.
- **Granularity** = per item, plus a one-click approve-all.
- **Rejection scope** = only the rejected items reopen; approved items keep their verdict.
- **Approval surface** = CRM only. No approval token.
- **Sequencing** = the in-flight branch lands first; this builds on top.

---

## 1. State machine

### Item — `scorecard_corrective_actions.status`

| From | Event | To |
| --- | --- | --- |
| `open` | super/PM submits a response | `submitted` |
| `rejected` | super/PM re-submits | `submitted` |
| `submitted` | approver approves | `approved` |
| `submitted` | approver rejects (comment required) | `rejected` |

`rejected` is deliberately distinct from `open`. Both are *outstanding*, but the UI and the PDF must
distinguish "not yet answered" from "answered, sent back, here is why" — collapsing them would discard the
approver's feedback exactly where the responder needs to read it.

**Every "is anything outstanding" predicate must treat `rejected` like `open`.** That is the single highest-risk
edit in this change: the existing predicate is `status = 'open'`, it appears in the auto-close check, the
reconcile arithmetic and the partial `scorecard_corrective_actions_open_idx`, and missing one leaves a card
that closes with rejected work in it.

The existing value `resolved` is renamed to `submitted` by migration. It currently means "the responder
answered", which is precisely what `submitted` now means — no data reinterpretation, just a clearer name for a
state that is no longer terminal.

### Card — `field_scorecards.status`

| From | Event | To |
| --- | --- | --- |
| `submitted` | below-band submit | `corrective_action_open` |
| `corrective_action_open` | last outstanding item submitted | `corrective_action_submitted` |
| `corrective_action_submitted` | last item approved | `corrective_action_closed` |
| `corrective_action_submitted` | any item rejected | `corrective_action_open` |

`corrective_action_submitted` is 27 characters and fits the existing `varchar(30)` — no third widen (0192
already took it from 20 to 30).

**`corrective_action_closed` keeps its name even though it now means "approved."** Renaming it would churn the
QC dashboard, the reports service, the client status badge and every hand-written runtime fixture for no
user-visible gain. The doc comment on the column records the shift in meaning.

---

## 2. Documenting the back-and-forth

This is what forces new storage. `scorecard_corrective_actions` holds a **single** set of response fields
(`response_comment`, `responder_name`, `responder_email`, `responded_at`). A reject-then-resubmit overwrites
them, so the history is destroyed by the very next submission — the PDF would show only the final attempt.

New per-office table `scorecard_corrective_action_events`, append-only:

| column | notes |
| --- | --- |
| `id` | uuid pk |
| `corrective_action_id` | FK → `scorecard_corrective_actions(id)` ON DELETE CASCADE |
| `scorecard_id` | denormalized, so the whole thread for a card is one indexed read |
| `event_type` | `submitted` \| `approved` \| `rejected` |
| `actor_user_id` | nullable — a token responder has no user id |
| `actor_name`, `actor_email` | captured at write time, so a later rename/archive cannot rewrite history |
| `comment` | the response text, or the rejection reason. Required for `rejected` |
| `created_at` | thread order |

The item row keeps CURRENT state (so every existing read stays cheap); the events table **is** the thread.

`field_scorecard_photos` gains a nullable `corrective_action_event_id` so "the photos from attempt 2" is still
answerable after attempt 3. The existing `corrective_action_id` link stays — it is what the current PDF and CRM
reads use, and it continues to mean "the photos for this item" in aggregate.

### Rendering

- **PDF** (`scorecard-pdf.ts`, the `CORRECTIVE ACTIONS` section the dependency branch adds): under each item,
  the chronological thread — each submission with its comment and photos, each verdict with its actor,
  timestamp and (for a rejection) the reason. The existing bounded-comment + capped-photo treatment applies per
  event, and the page-break guard must be recomputed for the taller block.
- **CRM** (`CorrectiveActionResponse` in `deal-scorecards-tab.tsx`): the same thread inline.

Both consume one ordering helper so they cannot drift — items by numeric `item_ref`, events by `created_at`.

---

## 3. Approval

### Authorization

`QC_APPROVER_EMAILS`, comma-separated, parsed with the same helper as the other email lists
(`parseReviewerEmails`). A session user may approve or reject when their email is in the list.

Consequences, stated plainly because they were chosen deliberately:
- Approval is **not** a role. Adding an email grants sign-off power on every deal, in every office.
- If the approver is unavailable, corrective actions **stall in `corrective_action_submitted`** until the env
  var is edited. There is no automatic escalation and no fallback approver.
- An unset/empty list means **nobody can approve**. The API returns 403 and the reason is logged; it must not
  silently fall back to a role check, which would quietly widen authority.

The approver still needs normal CRM access to the deal — the allowlist grants the approval verb, not visibility.

### API

- `POST /api/deals/:id/scorecards/:scorecardId/corrective-actions/:itemId/approve`
- `POST /api/deals/:id/scorecards/:scorecardId/corrective-actions/:itemId/reject` — `{ comment }`, required, non-empty
- `POST /api/deals/:id/scorecards/:scorecardId/corrective-actions/approve-all`

All three: take the parent-scorecard `FOR UPDATE` lock first (matching `resolveCorrectiveActionItemTx`), guard
the transition on the item's CURRENT status (`submitted` only), write the event row, recompute card status, and
enqueue any notification — **all in one transaction**. Status-guarding makes a double-click idempotent rather
than a double event.

`approve-all` approves every `submitted` item on the card in one transaction, and is a no-op for items in any
other state.

### UI

The deal Scorecards tab renders Approve / Reject per item, visible only to an authorized approver. Reject opens
a required comment box. A card-level "Approve all" appears when more than one item awaits approval.

The gate is server-authoritative; the client hides the controls purely as UX. A new
`GET /api/users/me/capabilities`-style flag (or an existing equivalent) tells the client whether to render them —
never the raw allowlist.

---

## 4. Notifications

| Trigger | To | Content |
| --- | --- | --- |
| **NEW** card → `corrective_action_submitted` | approver list | "Awaiting your approval" — the items and their responses, CRM link |
| **NEW** any item rejected | the cycle's super/PM responders | "Corrective action returned" — per-item rejection comments, fresh response link |
| **CHANGED** card → `corrective_action_closed` | oversight list | the dependency branch's "completed" email, relabelled **"approved"**, firing on final approval instead of last-answer |
| unchanged | responders | the existing below-band "corrective action required" email |
| unchanged | oversight list | the existing "opened" email |

**The rejection email MUST restart the responder notification cycle.** Their tokens were revoked when the cycle
was last stamped, so a rejection notice without a fresh cycle sends someone an email they cannot act on. Reuse
`restartCorrectiveActionNotificationCycleForDeal`'s machinery (mint a fresh `cycleNonce`, delete stale tokens,
re-enqueue) rather than hand-rolling a second token path.

Each new job gets its own idempotency stamp on `field_scorecards`, following the pattern established by the
oversight stamps: dedup on the stamp, use the cycle nonce only as the Resend idempotency-key dimension, and
apply a send-time state guard so a job whose card has moved on returns without sending or stamping.

---

## 5. QC Reports dashboard

`corrective_action_submitted` is neither open nor closed, and this repo's reconciliation rule requires the card,
the drawer and the aggregate to move together. The dashboard therefore needs a third bucket — **"Awaiting
approval"** — added to the KPI row, the filter and the drill-down in the same change. A KPI that counts rows the
drill-down does not return is the exact drift that rule exists to prevent.

---

## 6. Testing

- **State machine (runtime/PGlite):** every transition in §1, including the ones that must NOT happen — approving
  an `open` item, rejecting an `approved` one, double-approve idempotency, and a card with one rejected item
  never reaching `closed`.
- **Outstanding-predicate sweep:** a card with exactly one `rejected` item must report as outstanding at every
  site that asks — the auto-close check, the reconcile arithmetic, the card status and the dashboard bucket.
- **Thread integrity:** submit → reject → resubmit → approve produces four ordered events with the right actors,
  and the first submission's comment and photos are still readable after the second.
- **Authorization:** a non-allowlisted admin/director is 403; an allowlisted user succeeds; an empty
  `QC_APPROVER_EMAILS` 403s everyone and never falls back to a role check.
- **Rejection loop:** a rejection mints a fresh cycle with live tokens, and the emailed link actually authorizes
  the responder.
- **Rendering:** the PDF thread renders in order and stays inside the bottom margin (extend the existing
  inflate-and-check-y-positions test — the block is taller now); the CRM view shows the same order.
- **Reconciliation:** the dashboard's "Awaiting approval" count equals the rows its drill-down returns.

Run with `TZ=UTC`. Full gate is `npm run check:premerge` **plus** `npm run test:runtime --workspace=@trock-crm/server`
(CI runs the latter; the gate does not).

## 7. Out of scope

- Magic-link approval that authenticates navigation into a live session. Held in reserve if the CRM-only round
  trip proves to be a bottleneck; explicitly preferred over a standalone approval capability in an inbox.
- Approval from the mobile CRM app.
- Any automatic escalation, reminder or SLA on a card sitting in `corrective_action_submitted`.
- Backfilling existing `corrective_action_closed` cards — they stay closed and unreviewed.
